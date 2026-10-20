import sys
import pytest
from unittest.mock import patch, AsyncMock, MagicMock
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


# Mock pinecone
mock_pinecone_instance = MagicMock()
mock_pinecone_instance.list_indexes.return_value = []
mock_pinecone_instance.Index.return_value = MagicMock()

mock_pinecone_module = MagicMock()
mock_pinecone_module.Pinecone.return_value = mock_pinecone_instance
mock_pinecone_module.ServerlessSpec = MagicMock()

# Register pinecone and every submodule langchain_pinecone tries to reach
for _mod in [
    "pinecone",
    "pinecone.data",
    "pinecone.data.features",
    "pinecone.data.features.inference",
    "pinecone.data.features.inference.inference",
]:
    sys.modules[_mod] = mock_pinecone_module

# Mock langchain_pinecone itself so its real __init__ never runs
mock_lc_pinecone = MagicMock()
mock_lc_pinecone.PineconeVectorStore = MagicMock()
for _mod in [
    "langchain_pinecone",
    "langchain_pinecone.embeddings",
    "langchain_pinecone.vectorstores",
]:
    sys.modules[_mod] = mock_lc_pinecone

# Mock fastembed / FastEmbedEmbeddings
mock_fastembed = MagicMock()
sys.modules["fastembed"] = mock_fastembed

mock_langchain_community_embeddings = MagicMock()
sys.modules["langchain_community"] = MagicMock()
sys.modules["langchain_community.embeddings"] = mock_langchain_community_embeddings
mock_langchain_community_embeddings.FastEmbedEmbeddings = MagicMock(return_value=MagicMock())

# Mock langchain_groq (prevents ChatGroq from calling Groq API at import)
mock_groq = MagicMock()
sys.modules["langchain_groq"] = mock_groq

# Mock rank_bm25
sys.modules["rank_bm25"] = MagicMock()

# Mock mcp_client
mock_mcp_client = MagicMock()
mock_mcp_client.search_flights_serpapi = AsyncMock(return_value=[])
mock_mcp_client.format_flights_for_llm = MagicMock(return_value="")
mock_mcp_client.exa_destination_research = AsyncMock(return_value=[])
sys.modules["mcp_client"] = mock_mcp_client

# Mock langchain_mcp_adapters — imported by mcp_client
sys.modules["langchain_mcp_adapters"] = MagicMock()
sys.modules["langchain_mcp_adapters.client"] = MagicMock()

# Mock llm_providers — imported by mcp_client and backend
mock_llm_providers = MagicMock()
mock_llm_providers.groq_llm = MagicMock()
mock_llm_providers.groq_llm_structure = MagicMock()
sys.modules["llm_providers"] = mock_llm_providers

# Mock certifi — imported by mcp_client
sys.modules["certifi"] = MagicMock()

# Mock cloudinary
sys.modules["cloudinary"] = MagicMock()
sys.modules["cloudinary.uploader"] = MagicMock()
sys.modules["cloudinary.api"] = MagicMock()
sys.modules["cloudinary.utils"] = MagicMock()

# Mock authlib (OAuth)
sys.modules["authlib"] = MagicMock()
sys.modules["authlib.integrations"] = MagicMock()
sys.modules["authlib.integrations.starlette_client"] = MagicMock()

# Mock reportlab
sys.modules["reportlab"] = MagicMock()
sys.modules["reportlab.lib"] = MagicMock()
sys.modules["reportlab.lib.pagesizes"] = MagicMock()
sys.modules["reportlab.platypus"] = MagicMock()
sys.modules["reportlab.lib.styles"] = MagicMock()
sys.modules["reportlab.lib.units"] = MagicMock()


SQLITE_URL = "sqlite:///./test.db"
test_engine = create_engine(SQLITE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(bind=test_engine, autocommit=False, autoflush=False)

import database as _db_module          # noqa: E402  (import after sys.modules setup)
_db_module.engine = test_engine        # patch the engine object in-place
_db_module.DATABASE_URL = SQLITE_URL   # so any re-create also uses SQLite


from models import Base                # noqa: E402
Base.metadata.create_all(bind=test_engine)

from app import fastapi_app            # noqa: E402
from database import get_db            # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def create_test_tables():
    """Ensure tables exist; drop after full test session."""
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture
def db_session():
    """Single test DB session, rolled back after each test."""
    connection = test_engine.connect()
    transaction = connection.begin()
    session = TestingSessionLocal(bind=connection)
    yield session
    session.close()
    transaction.rollback()
    connection.close()


@pytest.fixture(scope="session")
def client():
    """
    FastAPI TestClient with all external services mocked.
    Uses fastapi_app directly (not the Socket.IO wrapper).
    """
    from fastapi.testclient import TestClient

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    with patch("backend.run_travel_workflow", new_callable=AsyncMock) as mock_travel, \
         patch("rag_backend.run_rag_workflow",  new_callable=AsyncMock) as mock_rag, \
         patch("rag_backend.add_document_to_pinecone", return_value={"doc_id": "test-id"}), \
         patch("rag_backend.delete_document",  return_value=True):

        mock_travel.return_value = {"result": "mocked travel plan"}
        mock_rag.return_value    = {"result": "mocked rag answer"}

        fastapi_app.dependency_overrides[get_db] = override_get_db

        with TestClient(fastapi_app, raise_server_exceptions=False) as test_client:
            yield test_client

    fastapi_app.dependency_overrides.clear()