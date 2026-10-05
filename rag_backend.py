"""
Trip Swarm — rag_backend.py

Agentic RAG using the 4-route architecture:
  Router LLM → kb / web / direct
  kb   → Pinecone hybrid (dense + BM25 + RRF)
  web  → Exa MCP (raw highlights + URLs)
  direct → no retrieval

Conversational memory: LangGraph MemorySaver checkpointer,
keyed by thread_id from the DB. stream_mode="values".

User isolation: every Pinecone vector is tagged with user_id
in metadata + stored in a per-user namespace.
"""

import os
import io
import uuid
from typing import Literal, Optional, List, Dict, Any

from dotenv import load_dotenv

from typing_extensions import TypedDict

from langchain_groq import ChatGroq
from langchain_core.messages import HumanMessage, SystemMessage, AIMessage, AnyMessage
from langgraph.graph.message import add_messages
from typing import Annotated
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_pinecone import PineconeVectorStore
from langchain_community.embeddings import FastEmbedEmbeddings

from pinecone import Pinecone, ServerlessSpec
from rank_bm25 import BM25Okapi

from langgraph.graph import StateGraph, END
from langgraph.checkpoint.memory import MemorySaver

load_dotenv()

# Config

PINECONE_API_KEY    = os.getenv("PINECONE_API_KEY", "")
PINECONE_INDEX_NAME = os.getenv("PINECONE_INDEX_NAME", "tripswarm-docs")
GROQ_API_KEY        = os.getenv("GROQ_API_KEY", "")

# Embeddings (384-dim, matches index)

embeddings_model = FastEmbedEmbeddings(
    model_name="sentence-transformers/all-MiniLM-L6-v2",
)

# Pinecone client + index (auto-create if missing) 

_pc = Pinecone(api_key=PINECONE_API_KEY)

if PINECONE_INDEX_NAME not in [idx.name for idx in _pc.list_indexes()]:
    _pc.create_index(
        name=PINECONE_INDEX_NAME,
        dimension=384,
        metric="cosine",
        spec=ServerlessSpec(cloud="aws", region="us-east-1"),
    )

_pinecone_index = _pc.Index(PINECONE_INDEX_NAME)

# LLMs 

router_llm = ChatGroq(
    api_key=GROQ_API_KEY,
    model="openai/gpt-oss-20b",
    temperature=0,
    max_tokens=768,
)

final_llm = ChatGroq(
    api_key=GROQ_API_KEY,
    model="openai/gpt-oss-120b",
    temperature=0,
    max_tokens=2048,
)

#  Checkpointer (thread-level memory)

checkpointer = MemorySaver()

# RAG Socket.IO progress 

_rag_sio = None


def set_rag_socketio(sio):
    global _rag_sio
    _rag_sio = sio


async def _emit_rag_progress(sid: Optional[str], status: str, detail: str = ""):
    if _rag_sio and sid:
        await _rag_sio.emit("rag_progress", {"status": status, "detail": detail}, to=sid)




#  Document Processing

def extract_text_from_file(content: bytes, filename: str, content_type: str) -> str:
    """Extract plain text from PDF, DOCX, or text files."""
    name = (filename or "").lower()
    ct   = (content_type or "").lower()

    if name.endswith(".pdf") or "pdf" in ct:
        try:
            import PyPDF2
            reader = PyPDF2.PdfReader(io.BytesIO(content))
            return "\n\n".join(
                p.extract_text() for p in reader.pages if p.extract_text()
            )
        except Exception as e:
            print(f"PDF extraction error: {e}")
            return ""

    if name.endswith(".docx") or "word" in ct or "openxmlformats" in ct:
        try:
            import docx
            doc = docx.Document(io.BytesIO(content))
            return "\n".join(p.text for p in doc.paragraphs if p.text.strip())
        except Exception as e:
            print(f"DOCX extraction error: {e}")
            return ""

    try:
        return content.decode("utf-8", errors="ignore")
    except Exception:
        return ""


async def add_document_to_pinecone(
    file_content: bytes,
    filename: str,
    content_type: str,
    user_id: str,
) -> str:
    """
    Chunk → embed → upsert into Pinecone.
    Uses per-user namespace for isolation.
    Returns doc_id (UUID).
    """
    text = extract_text_from_file(file_content, filename, content_type)
    if not text.strip():
        print(f"Warning: no text extracted from {filename}")
        return str(uuid.uuid4())

    splitter = RecursiveCharacterTextSplitter(
        chunk_size=800,
        chunk_overlap=120,
        separators=["\n\n", "\n", ". ", "! ", "? ", " ", ""],
        keep_separator=False,
    )
    chunks = splitter.split_text(text)
    if not chunks:
        return str(uuid.uuid4())

    doc_id    = str(uuid.uuid4())
    namespace = f"user_{user_id}"

    # Build LangChain Document objects so PineconeVectorStore handles embedding
    from langchain_core.documents import Document as LCDocument

    lc_docs = [
        LCDocument(
            page_content=chunk,
            metadata={
                "user_id":      user_id,
                "doc_id":       doc_id,
                "filename":     filename,
                "chunk_index":  i,
                "total_chunks": len(chunks),
            },
        )
        for i, chunk in enumerate(chunks)
    ]

    PineconeVectorStore.from_documents(
        documents=lc_docs,
        embedding=embeddings_model,
        index_name=PINECONE_INDEX_NAME,
        namespace=namespace,
    )

    print(f"Upserted {len(chunks)} chunks for {filename} (user={user_id}, doc_id={doc_id})")
    return doc_id


async def delete_document(pinecone_doc_id: str, user_id: str) -> None:
    """Delete all vectors for a document from the user's namespace."""
    namespace = f"user_{user_id}"
    try:
        probe_vec = embeddings_model.embed_query("document")
        results   = _pinecone_index.query(
            vector=probe_vec,
            top_k=1000,
            filter={"doc_id": {"$eq": pinecone_doc_id}},
            namespace=namespace,
            include_metadata=False,
            include_values=False,
        )
        ids = [m["id"] for m in results.get("matches", [])]
        if ids:
            _pinecone_index.delete(ids=ids, namespace=namespace)
            print(f"Deleted {len(ids)} vectors for doc_id={pinecone_doc_id}")
    except Exception as e:
        print(f"Error deleting from Pinecone: {e}")




#  Hybrid Search (Dense + BM25 + RRF) via LangChain PineconeVectorStore

def hybrid_search(query: str, user_id: str, n_results: int = 5) -> List[Dict[str, Any]]:
    namespace = f"user_{user_id}"

    vectorstore = PineconeVectorStore(
        index=_pinecone_index,
        embedding=embeddings_model,
        namespace=namespace,
    )
    # Remove namespace from search_kwargs — it's already set on the store
    retriever = vectorstore.as_retriever(
        search_kwargs={"k": min(n_results * 4, 40)},
    )

    try:
        dense_docs = retriever.invoke(query)
    except Exception as e:
        print(f"Pinecone retrieval error: {e}")
        return []

    if not dense_docs:
        return []

    corpus     = [d.page_content for d in dense_docs]
    tokenized  = [c.lower().split() for c in corpus]
    bm25       = BM25Okapi(tokenized)
    bm25_scores = bm25.get_scores(query.lower().split())

    dense_ranks  = {i: i + 1 for i in range(len(dense_docs))}
    bm25_order   = sorted(range(len(bm25_scores)), key=lambda i: bm25_scores[i], reverse=True)
    sparse_ranks = {orig: rank + 1 for rank, orig in enumerate(bm25_order)}

    K = 60
    rrf_scores = {
        i: 1.0 / (K + dense_ranks[i]) + 1.0 / (K + sparse_ranks[i])
        for i in range(len(dense_docs))
    }

    top_indices = sorted(rrf_scores, key=lambda i: rrf_scores[i], reverse=True)[:n_results]

    return [
        {
            "content":  dense_docs[i].page_content,
            "metadata": dense_docs[i].metadata,
            "score":    round(rrf_scores[i], 4),
        }
        for i in top_indices
    ]



#  RAG State

MAX_HISTORY_MESSAGES = 10   # keep last N messages (user + assistant pairs)

class RAGState(TypedDict):
    # Conversational memory — add_messages reducer handles appending/deduplication
    messages:       Annotated[list[AnyMessage], add_messages]

    # Inputs
    query:          str
    user_id:        str
    _sid:           Optional[str]           # socket sid for progress events

    # Routing
    route:          Optional[str]           # "kb" | "web" | "direct"

    # Retrieved content
    kb_docs:        List[Dict[str, Any]]    # from Pinecone
    web_highlights: List[str]               # from Exa (text only → LLM)
    web_urls:       List[str]               # from Exa (URLs → artifact)

    # Output
    answer:         str
    source:         str                     # "kb" | "web" | "direct" | "error"




#  Node 1 — Router

_ROUTER_SYSTEM_WITH_DOCS = """You are a query router for a travel assistant application.

Your job is to decide which information source is REQUIRED to answer the user's CURRENT question.

The user has uploaded documents to their personal knowledge base, such as:
- itineraries
- travel plans
- visa guides
- booking documents
- PDFs
- destination notes

Choose exactly ONE route:

1. kb
Use KB when the answer requires information from the user's uploaded documents.

Examples:
- "What does my itinerary say?"
- "What is planned for day 3?"
- "According to my travel plan, which hotel am I staying at?"
- "What attraction am I visiting on day 2?"
- "What does my uploaded visa document say?"
- "Summarize my itinerary."
- "Where does my itinerary say I will stay?"

Important:
A question mentioning "my trip", "my plan", or "my itinerary" does NOT automatically mean KB.
Choose KB only when the user's uploaded content is needed to answer.

2. web
Use WEB when the answer requires current, live, recent, or externally available information.

Examples:
- "What is the current weather in Bangkok?"
- "What are the current opening hours of the Grand Palace?"
- "What are today's flight prices?"
- "Do I need a visa right now?"
- "What is the latest Thailand visa rule?"
- "Is this attraction open today?"
- "What are the current hotel prices?"

3. direct
Use DIRECT when the question can be answered from general knowledge without using:
- the user's uploaded documents
- current/live web information

Examples:
- "What is the capital of France?"
- "What currency does Japan use?"
- "What does backpacking mean?"
- "What is the difference between a hotel and a hostel?"

Routing rules:

RULE 1:
Route based on what information is REQUIRED to answer the question, not merely on words such as "my trip", "my plan", or "my itinerary".

RULE 2:
If the question explicitly refers to specific information in the user's uploaded documents, prefer KB.

RULE 3:
If the question requires current, live, recent, or time-sensitive information, prefer WEB.

RULE 4:
If neither the user's documents nor current web information is required, choose DIRECT.

RULE 5:
If a question contains multiple parts, consider ALL parts before choosing the route.
- Document only → KB
- Current/external information only → WEB
- Neither → DIRECT

RULE 6:
Do not choose KB merely because the user has uploaded documents.
Do not choose WEB merely because the question is about travel.

RULE 7:
When the user refers to previous conversation context, use the conversation history to determine whether that context refers to their uploaded documents or their personal travel plan.

"""


_ROUTER_SYSTEM_WITHOUT_DOCS = """You are a query router for a travel assistant application.

Your job is to decide which information source is REQUIRED to answer the user's CURRENT question.

The user has NOT uploaded any documents to their knowledge base.
Do NOT choose kb — the user has no documents to search.

Choose exactly ONE route:

1. web
Use WEB when the answer requires current, live, recent, or externally available information.

Examples:
- "What is the current weather in Bangkok?"
- "What are the current opening hours of the Grand Palace?"
- "What are today's flight prices?"
- "Do I need a visa right now?"
- "What is the latest Thailand visa rule?"
- "Is this attraction open today?"

2. direct
Use DIRECT when the question can be answered from general knowledge without needing current or live web information.

Examples:
- "What is the capital of France?"
- "What currency does Japan use?"
- "What does backpacking mean?"
- "What is the difference between a hotel and a hostel?"

Routing rules:
- If current, live, or time-sensitive information is needed → WEB
- If general knowledge is sufficient → DIRECT
- Never choose kb

"""


async def route_query_node(state: RAGState) -> RAGState:
    from database import SessionLocal
    from models import UserDocument
    import json
    import re

    await _emit_rag_progress(state.get("_sid"), "analysing", "Analysing your question…")

    has_docs = False
    try:
        db = SessionLocal()
        try:
            doc_count = (
                db.query(UserDocument)
                .filter(UserDocument.user_id == uuid.UUID(str(state["user_id"])))
                .count()
            )
            has_docs = doc_count > 0
        finally:
            db.close()
    except Exception as e:
        print(f"[router] DB doc check failed: ({type(e).__name__}), assuming no docs: {e}")
        has_docs = False

    system_prompt = (
        _ROUTER_SYSTEM_WITH_DOCS if has_docs else _ROUTER_SYSTEM_WITHOUT_DOCS
    )

    # Append a strict JSON-only instruction so the model never uses tool-calling
    json_instruction = """
        IMPORTANT: You must respond with ONLY a valid JSON object and absolutely nothing else.
        No explanation, no markdown, no code fences. Just raw JSON.

        Your response must be exactly in this format:
        {"route": "<your choice>"}

        Where <your choice> is exactly one of: "kb", "web", "direct"

        Example valid responses:
        {"route": "web"}
        {"route": "kb"}
        {"route": "direct"}
        """

    VALID_ROUTES = {"kb", "web", "direct"}

    try:
        response: AIMessage = router_llm.invoke([
            SystemMessage(content=system_prompt + json_instruction),
            HumanMessage(content=state["query"]),
        ])

        raw = response.content.strip()
        print(f"[router] raw response: {raw!r}")

        # ── Attempt 1: direct JSON parse ──────
        route = None
        try:
            parsed = json.loads(raw)
            route  = parsed.get("route", "").lower().strip()
        except json.JSONDecodeError:
            pass

        # ── Attempt 2: extract JSON object from surrounding text ─────
        if route not in VALID_ROUTES:
            match = re.search(r'\{[^}]*"route"\s*:\s*"(\w+)"[^}]*\}', raw)
            if match:
                route = match.group(1).lower().strip()

        # ── Attempt 3: look for a bare route word anywhere in the text ────
        if route not in VALID_ROUTES:
            for candidate in VALID_ROUTES:
                if candidate in raw.lower():
                    route = candidate
                    print(f"[router] fallback word-match: {route!r}")
                    break

        # ── Attempt 4: safe default ───────
        if route not in VALID_ROUTES:
            route = "web" if not has_docs else "direct"
            print(f"[router] could not parse route, defaulting to: {route!r}")

        # Safety: no-doc users cannot use KB
        if not has_docs and route == "kb":
            print(f"[router] model chose 'kb' but user has no docs — correcting to 'direct'")
            route = "direct"

    except Exception as e:
        print(f"[router] routing failed: {e}")
        raise RuntimeError(f"Router failed to produce a valid route: {e}") from e

    print(f"[router] has_docs={has_docs} → route={route}")
    return {**state, "route": route}






#  Node 2a — KB (Pinecone hybrid search)


async def kb_search_node(state: RAGState) -> RAGState:
    await _emit_rag_progress(state.get("_sid"), "retrieving_docs", "Retrieving from your documents…")
    try:
        docs = hybrid_search(query=state["query"], user_id=state["user_id"], n_results=5)
        print(f"[kb_search] retrieved {len(docs)} chunks")
        return {**state, "kb_docs": docs}
    except Exception as e:
        err_msg = f"Failed to retrieve from your documents: {str(e)}"
        await _emit_rag_progress(state.get("_sid"), "rag_error", err_msg)
        return {**state, "kb_docs": [], "answer": err_msg, "source": "error"}



#  Node 2b — Web (Exa MCP)

async def web_search_node(state: RAGState) -> RAGState:
    await _emit_rag_progress(state.get("_sid"), "searching_web", "Searching the web…")
    try:
        from mcp_client import exa_rag_search
        result = await exa_rag_search(state["query"])
        print(f"[web_search] got {len(result['highlights'])} highlights, {len(result['urls'])} urls")
        return {
            **state,
            "web_highlights": result["highlights"],
            "web_urls":       result["urls"],
        }
    except Exception as e:
        err_msg = f"Web search failed: {str(e)}"
        await _emit_rag_progress(state.get("_sid"), "rag_error", err_msg)
        return {**state, "web_highlights": [], "web_urls": [], "answer": err_msg, "source": "error"}






#  Node 3 — Final LLM


_FINAL_SYSTEM = """You are Trip Swarm's travel assistant.
Answer the user's question using the context provided below.
Be concise — 2–4 sentences unless the user asks for detail.
If the context doesn't cover the question, say so briefly and supplement with general knowledge.
For real-time info (prices, availability, live visa rules) always recommend official sources."""


async def final_llm_node(state: RAGState) -> RAGState:
    """
    Single LLM call that generates the answer.
    Passes trimmed message history (last MAX_HISTORY_MESSAGES) for conversational context.
    Appends the new HumanMessage + AIMessage back into state["messages"].
    """
    # Short-circuit if a retrieval node already set an error answer
    if state.get("source") == "error":
        await _emit_rag_progress(state.get("_sid"), "rag_done", "Done")
        return state

    await _emit_rag_progress(state.get("_sid"), "thinking", "Thinking…")
    route = state.get("route", "direct")
    parts: List[str] = []

    # KB chunks
    kb_docs = state.get("kb_docs", [])
    if kb_docs:
        kb_text = "\n\n---\n\n".join(
            f"[Source: {d['metadata'].get('filename', 'your document')}]\n{d['content']}"
            for d in kb_docs
        )
        parts.append(f"=== KNOWLEDGE BASE (your documents) ===\n{kb_text}")

    # Web highlights — formatted as numbered results
    web_highlights = state.get("web_highlights", [])
    if web_highlights:
        result_blocks = "\n\n".join(
            f"---- Result {i} ----\n{h}"
            for i, h in enumerate(web_highlights, 1)
        )
        parts.append(f"=== WEB SEARCH RESULTS ===\n{result_blocks}")

    context = "\n\n".join(parts) if parts else ""

    system_content = f"{_FINAL_SYSTEM}\n\n{context}" if context else _FINAL_SYSTEM

    # ── Build trimmed history ─────────
    # state["messages"] already contains prior turns (restored by MemorySaver).
    # Trim to the last MAX_HISTORY_MESSAGES to keep the context window bounded.

    prior_messages: list[AnyMessage] = state.get("messages", [])
    trimmed_history = prior_messages[-MAX_HISTORY_MESSAGES:] if prior_messages else []

    # Current turn's human message
    current_human = HumanMessage(content=state["query"])

    messages_to_send = (
        [SystemMessage(content=system_content)]
        + trimmed_history
        + [current_human]
    )

    try:
        resp   = final_llm.invoke(messages_to_send)
        answer = resp.content
    except Exception as e:
        answer = f"I encountered an error generating a response. Please try again. ({e})"

    source_map = {
        "kb":     "kb",
        "web":    "web",
        "direct": "direct",
    }
    await _emit_rag_progress(state.get("_sid"), "rag_done", "Done ✓")

    # ── Append this turn to messages so MemorySaver persists it ──────────
    new_messages = [current_human, AIMessage(content=answer)]

    return {
        **state,
        "answer":   answer,
        "source":   source_map.get(route, "direct"),
        "messages": new_messages,   # add_messages reducer appends, not overwrites
    }



#  Conditional routing edges

def decide_retrieval(state: RAGState) -> str:
    return state.get("route", "direct")



#  Build LangGraph

_graph_builder = StateGraph(RAGState)

_graph_builder.add_node("route_query",       route_query_node)
_graph_builder.add_node("kb_search",         kb_search_node)
_graph_builder.add_node("web_search",        web_search_node)
_graph_builder.add_node("final_llm",         final_llm_node)

_graph_builder.set_entry_point("route_query")

_graph_builder.add_conditional_edges(
    "route_query",
    decide_retrieval,
    {
        "kb":     "kb_search",
        "web":    "web_search",
        "direct": "final_llm",   # skip retrieval
    },
)

# All retrieval nodes → final LLM
_graph_builder.add_edge("kb_search",  "final_llm")
_graph_builder.add_edge("web_search", "final_llm")
_graph_builder.add_edge("final_llm",  END)

# Compile with MemorySaver checkpointer for thread-level conversational memory
rag_app = _graph_builder.compile(checkpointer=checkpointer)



#  Public API

async def run_rag_workflow(
    query:        str,
    user_id:      str,
    thread_id:    str,                              # DB thread_id → LangGraph config key
    sid:          str = "",                         # socket sid for progress events
) -> Dict[str, Any]:
    """
    Run the agentic RAG workflow.

    thread_id is used as the LangGraph thread identifier so MemorySaver
    automatically restores the conversation context for that thread.

    Returns: { answer, source, documents_used, web_urls }
    """
    initial_state = RAGState(
        messages=[],            # MemorySaver will merge stored history on top of this
        query=query,
        user_id=user_id,
        _sid=sid or "",
        route=None,
        kb_docs=[],
        web_highlights=[],
        web_urls=[],
        answer="",
        source="",
    )

    config = {
        "configurable": {
            "thread_id": f"rag_{thread_id}",   # namespace to avoid clashes with travel threads
        },
        "recursion_limit": 10,
    }

    final_state: RAGState = await rag_app.ainvoke(
        initial_state,
        config=config,
    )

    kb_docs = final_state.get("kb_docs", [])

    source = final_state.get("source", "direct")
    # Treat error source as direct for the frontend badge, answer already has the error text
    return {
        "answer":  final_state["answer"],
        "source":  "direct" if source == "error" else source,
        "is_error": source == "error",
        "documents_used": [
            {
                "filename":    d["metadata"].get("filename", "unknown"),
                "score":       round(d["score"], 4),
                "chunk":       d["content"][:600],
                "chunk_index": d["metadata"].get("chunk_index", 0),
            }
            for d in kb_docs
        ],
        "web_urls": [] if source == "error" else final_state.get("web_urls", []),
    }