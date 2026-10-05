"""
Trip Swarm — models.py
SQLAlchemy ORM models for PostgreSQL
"""

from datetime import datetime
import uuid
from sqlalchemy import (
    Column, Integer, BigInteger, String, Text,
    DateTime, ForeignKey, JSON
)
from sqlalchemy.orm import relationship, declarative_base
from sqlalchemy.types import Uuid

Base = declarative_base()


class User(Base):
    """Google OAuth users."""
    __tablename__ = "users"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    google_id = Column(String(128), unique=True, index=True, nullable=True)   # nullable for OTP-only users
    email     = Column(String(255), unique=True, index=True, nullable=False)
    name      = Column(String(255), nullable=False)
    picture   = Column(Text, nullable=True)
    country   = Column(String(100), nullable=True)
    auth_provider = Column(String(50), nullable=False, default="google")  # "google" | "otp" | "both"
    is_verified   = Column(Integer, default=1, nullable=False)             # 1 = verified
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_login = Column(DateTime, default=datetime.utcnow, nullable=False)

    threads   = relationship("ChatThread",   back_populates="user", cascade="all, delete-orphan")
    reports   = relationship("TripReport",   back_populates="user", cascade="all, delete-orphan")
    documents = relationship("UserDocument", back_populates="user", cascade="all, delete-orphan")
    summaries = relationship("TripSummary",  back_populates="user", cascade="all, delete-orphan")

    def __repr__(self):
        return f"<User id={self.id} email={self.email}>"


class OtpToken(Base):
    """Stores pending OTP codes."""
    __tablename__ = "otp_tokens"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4,index=True)
    email      = Column(String(255), unique=True, index=True, nullable=False)
    code       = Column(String(10), nullable=False)
    name       = Column(String(255), nullable=True)   # stored for new-user signup
    expires_at = Column(DateTime, nullable=False)
    tries      = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    def __repr__(self):
        return f"<OtpToken email={self.email}>"


class ChatThread(Base):
    __tablename__ = "chat_threads"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    thread_type = Column(String(20), nullable=False, default="travel")
    title       = Column(String(512), nullable=False, default="New Chat")
    created_at  = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at  = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    user     = relationship("User",        back_populates="threads")
    messages = relationship("ChatMessage", back_populates="thread", cascade="all, delete-orphan")
    reports  = relationship("TripReport",  back_populates="thread")
    summaries = relationship("TripSummary", back_populates="thread")

    def __repr__(self):
        return f"<ChatThread id={self.id} type={self.thread_type} user={self.user_id}>"


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    thread_id = Column(Uuid(as_uuid=True), ForeignKey("chat_threads.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    role       = Column(String(20),  nullable=False)
    content    = Column(Text,        nullable=False)
    msg_type       = Column(String(50),  nullable=True, default="text")
    attached_files = Column(JSON, nullable=True)   # [{filename, db_id, file_url, content_type}]
    created_at     = Column(DateTime, default=datetime.utcnow, nullable=False)

    thread = relationship("ChatThread", back_populates="messages")

    def __repr__(self):
        return f"<ChatMessage id={self.id} role={self.role} thread={self.thread_id}>"


class TripReport(Base):
    __tablename__ = "trip_reports"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    thread_id = Column(Uuid(as_uuid=True), ForeignKey("chat_threads.id", ondelete="SET NULL"), nullable=True)
    assistant_chat_id = Column(Uuid(as_uuid=True), ForeignKey("chat_messages.id", ondelete="SET NULL"), nullable=True, index=True)
    trip_summary_id = Column(Uuid(as_uuid=True), ForeignKey("trip_summaries.id", ondelete="SET NULL"), nullable=True, index=True)

    title             = Column(String(512), nullable=False)
    content           = Column(Text,        nullable=False)
    is_favourite      = Column(Integer, default=0, nullable=False)   # 0 = no, 1 = yes
    feedback          = Column(String(10), nullable=True)             # 'like' | 'dislike' | None
    created_at        = Column(DateTime, default=datetime.utcnow, nullable=False)

    user   = relationship("User",       back_populates="reports")
    thread = relationship("ChatThread", back_populates="reports")

    def __repr__(self):
        return f"<TripReport id={self.id} user={self.user_id} title={self.title[:40]}>"


class TripSummary(Base):
    """
    Stores the parsed trip summary card data (dates, flight prefs, travel prefs)
    so it survives page reload and is linked to thread + message.
    """
    __tablename__ = "trip_summaries"


    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    thread_id = Column(Uuid(as_uuid=True), ForeignKey("chat_threads.id", ondelete="CASCADE"), nullable=True)
    assistant_chat_id = Column(Uuid(as_uuid=True), ForeignKey("chat_messages.id", ondelete="SET NULL"), nullable=True, index=True,)
    trip_info         = Column(JSON, nullable=True)
    flight_prefs  = Column(JSON, nullable=True)
    travel_prefs  = Column(JSON, nullable=True)
    created_at    = Column(DateTime, default=datetime.utcnow, nullable=False)

    user   = relationship("User",       back_populates="summaries")
    thread = relationship("ChatThread", back_populates="summaries")


class TripSource(Base):
    """
    Stores flight results text and destination URLs per trip run so sources panel
    can be shown after reload.
    """
    __tablename__ = "trip_sources"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    thread_id = Column(Uuid(as_uuid=True), ForeignKey("chat_threads.id", ondelete="CASCADE"), nullable=True)
    assistant_chat_id = Column(Uuid(as_uuid=True), ForeignKey("chat_messages.id", ondelete="SET NULL"), nullable=True, index=True)
    flight_results_text = Column(Text, nullable=True) 
    destination_urls    = Column(JSON, nullable=True)    
    created_at          = Column(DateTime, default=datetime.utcnow, nullable=False)

    def __repr__(self):
        return f"<TripSource id={self.id} thread={self.thread_id}>"


class RagRetrievedChunk(Base):
    """
    Stores the document chunks and web URLs retrieved during a RAG answer,
    linked to the assistant chat message so they can be shown
    as an artifact after page reload.
    """
    __tablename__ = "rag_retrieved_chunks"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    thread_id = Column(Uuid(as_uuid=True), ForeignKey("chat_threads.id", ondelete="CASCADE"), nullable=True)
    assistant_chat_id = Column(Uuid(as_uuid=True), ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=False, index=True)
    chunks            = Column(JSON, nullable=True)   # [{filename, chunk, chunk_index, score}]
    web_urls          = Column(JSON, nullable=True)   # [url, url, ...]
    source            = Column(String(20), nullable=True)  # "kb" | "web" | "both" | "direct"
    created_at        = Column(DateTime, default=datetime.utcnow, nullable=False)

    def __repr__(self):
        return f"<RagRetrievedChunk id={self.id} msg={self.assistant_chat_id}>"


class UserDocument(Base):
    __tablename__ = "user_documents"

    id = Column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    user_id = Column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    filename       = Column(String(255),nullable=False)
    pinecone_doc_id  = Column(String(255),nullable=True)
    cloudinary_public_id = Column(String(512), nullable=True)
    file_url       = Column(Text,       nullable=True)    # public or signed URL (refreshed on demand)
    file_size      = Column(BigInteger, default=0)
    content_type   = Column(String(100),nullable=True)
    created_at     = Column(DateTime,  default=datetime.utcnow, nullable=False)

    user = relationship("User", back_populates="documents")

    def __repr__(self):
        return f"<UserDocument id={self.id} filename={self.filename} user={self.user_id}>"