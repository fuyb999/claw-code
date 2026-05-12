# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS web-builder

WORKDIR /workspace/web

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

FROM rust:1.81-bookworm AS rust-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        libssl-dev \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/rust

COPY rust/ ./
RUN cargo build --locked --release -p clawd

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system clawd \
    && useradd --system --gid clawd --create-home --home-dir /app clawd \
    && mkdir -p /app/bin /app/data /app/web

WORKDIR /app

COPY --from=rust-builder /workspace/rust/target/release/clawd /app/bin/clawd
COPY --from=web-builder /workspace/web/dist /app/web/dist

RUN chown -R clawd:clawd /app

ENV CLAWD_BIND_ADDR=0.0.0.0:3210
ENV CLAWD_DATA_DIR=/app/data
ENV CLAWD_WEB_DIST_DIR=/app/web/dist

EXPOSE 3210
VOLUME ["/app/data"]

USER clawd

ENTRYPOINT ["/app/bin/clawd"]
