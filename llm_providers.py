"""
llm_providers.py
Centralised LLM instances for TripSwarm.
"""
import os
from dotenv import load_dotenv
from langchain_groq import ChatGroq

load_dotenv()

# ── Groq — GPT-OSS 120B (itinerary, final response, RAG) ──────────────────────
groq_llm = ChatGroq(
    api_key=os.getenv("GROQ_API_KEY", ""),
    model="openai/gpt-oss-120b",
    temperature=0,
)

# ── Groq — GPT-OSS 20B (query parsing, destination research structuring) ──────
# Used for: extracting structured travel parameters from user queries
groq_llm_extract = ChatGroq(
    api_key=os.getenv("GROQ_API_KEY", ""),
    model="openai/gpt-oss-20b",
    temperature=0,
    max_tokens=1024,
)

# Used for: structuring Exa destination research into concise sections
groq_llm_structure = ChatGroq(
    api_key=os.getenv("GROQ_API_KEY", ""),
    model="openai/gpt-oss-20b",
    temperature=0,
    max_tokens=6000,
)