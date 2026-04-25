# SPIRE — backend container.
# Multi-stage: builder pulls Python deps; runtime ships only what we need so the
# image stays small enough for an air-gap conex (~250MB).

FROM python:3.12-slim AS builder
WORKDIR /opt/spire
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt /tmp/requirements.txt
COPY dataset/requirements.txt /tmp/requirements-dataset.txt
RUN pip install --no-cache-dir --prefix=/install -r /tmp/requirements.txt
RUN pip install --no-cache-dir --prefix=/install -r /tmp/requirements-dataset.txt


FROM python:3.12-slim
WORKDIR /opt/spire
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /install /usr/local

COPY backend/ ./backend/
COPY dataset/ ./dataset/

ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/opt/spire
ENV SPIRE_MODE=full

# Persisted state — mount this to a host volume in production.
VOLUME ["/opt/spire/runtime"]

EXPOSE 8700

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8700/api/system/status || exit 1

CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8700"]
