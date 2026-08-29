# SPIRE — backend container.
# Multi-stage: builder pulls Python deps; runtime ships only what we need so the
# image stays small enough for an air-gap conex (~250MB).

# Base images are digest-pinned so an image built next month is the image
# reviewed today. Dependabot bumps the digest with the tag; update both
# together or the comment lies.
# python:3.12-slim
FROM python@sha256:b0aed0e0059e9b1527ef57689a7206f32526627b0713e2228a916df62880188a AS builder
WORKDIR /opt/spire
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt /tmp/requirements.txt
COPY dataset/requirements.txt /tmp/requirements-dataset.txt
RUN pip install --no-cache-dir --prefix=/install -r /tmp/requirements.txt
RUN pip install --no-cache-dir --prefix=/install -r /tmp/requirements-dataset.txt


# python:3.12-slim
FROM python@sha256:b0aed0e0059e9b1527ef57689a7206f32526627b0713e2228a916df62880188a
WORKDIR /opt/spire
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -r spire && useradd -r -g spire -u 10001 spire
COPY --from=builder /install /usr/local

COPY backend/ ./backend/
COPY dataset/ ./dataset/

ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/opt/spire
ENV SPIRE_MODE=full

# Persisted state — mount this to a host volume in production. Owned by the
# non-root runtime user so the app can write the (encrypted) DB.
RUN mkdir -p /opt/spire/runtime && chown -R spire:spire /opt/spire
VOLUME ["/opt/spire/runtime"]

EXPOSE 8700

# Run as an unprivileged user (least privilege, 800-171 3.1 / 3.4.6).
USER spire

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8700/api/system/status || exit 1

CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8700"]
