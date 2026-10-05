# Stage 1: Build 

FROM python:3.11-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    gcc \
    g++ \
    libpq-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Set an explicit, predictable cache path before downloading
ENV FASTEMBED_CACHE_PATH=/app/fastembed_cache
ENV HF_HOME=/app/fastembed_cache

RUN python -c "from fastembed import TextEmbedding; model = TextEmbedding('sentence-transformers/all-MiniLM-L6-v2'); list(model.embed(['warmup'])); print('fastembed model cached successfully')"

# Stage 2: Slim runtime 

FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy installed Python packages from builder
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy cached model from the explicit path we set
COPY --from=builder /app/fastembed_cache /app/fastembed_cache

# Copy application source
COPY . .

# Tell runtime where the cache lives
ENV FASTEMBED_CACHE_PATH=/app/fastembed_cache
ENV HF_HOME=/app/fastembed_cache


ENV PORT=8000
ENV PYTHONUNBUFFERED=1

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

CMD uvicorn app:app --host 0.0.0.0 --port ${PORT} --workers 1