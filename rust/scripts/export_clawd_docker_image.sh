#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_TAG="${IMAGE_TAG:-clawd-web-agent:local}"
IMAGE_PLATFORM="${IMAGE_PLATFORM:-linux/amd64}"
OUTPUT_PATH="${1:-$ROOT_DIR/clawd-web-agent-image-linux-amd64.tar}"
WEB_DIR="$ROOT_DIR/web"
RUST_DIR="$ROOT_DIR/rust"
LINUX_TARGET_TRIPLE="${LINUX_TARGET_TRIPLE:-x86_64-unknown-linux-gnu}"
LINUX_OUT_DIR="$ROOT_DIR/release/linux-build"
LINUX_OUT_BIN="$LINUX_OUT_DIR/clawd"
CONTEXT_DIR="$ROOT_DIR/release/docker-image-context"
CARGO_REGISTRY_DIR="${CARGO_REGISTRY_DIR:-$HOME/.cargo/registry}"
CARGO_GIT_DIR="${CARGO_GIT_DIR:-$HOME/.cargo/git}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/release"

echo "[1/5] build web"
(cd "$WEB_DIR" && npm run build)

echo "[2/5] build linux clawd"
mkdir -p "$CARGO_REGISTRY_DIR" "$CARGO_GIT_DIR"
rm -rf "$LINUX_OUT_DIR"
mkdir -p "$LINUX_OUT_DIR"
docker run --rm \
  --platform "$IMAGE_PLATFORM" \
  -v "$RUST_DIR:/work" \
  -v "$LINUX_OUT_DIR:/out" \
  -v "$CARGO_REGISTRY_DIR:/usr/local/cargo/registry" \
  -v "$CARGO_GIT_DIR:/usr/local/cargo/git" \
  -w /work \
  rust:1.81-bookworm \
  bash -lc "export PATH=/usr/local/cargo/bin:\$PATH \
    && export CARGO_TARGET_DIR=/tmp/cargo-target \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl-dev pkg-config \
    && /usr/local/cargo/bin/cargo build --locked --release --target $LINUX_TARGET_TRIPLE -p clawd \
    && cp /tmp/cargo-target/$LINUX_TARGET_TRIPLE/release/clawd /out/clawd"

if [ ! -f "$LINUX_OUT_BIN" ]; then
  echo "linux clawd binary not found at $LINUX_OUT_BIN" >&2
  exit 1
fi
chmod +x "$LINUX_OUT_BIN"

echo "[3/5] assemble runtime image context"
rm -rf "$CONTEXT_DIR"
mkdir -p "$CONTEXT_DIR/app/bin" "$CONTEXT_DIR/app/web"
cp "$LINUX_OUT_BIN" "$CONTEXT_DIR/app/bin/clawd"
chmod +x "$CONTEXT_DIR/app/bin/clawd"
cp -R "$WEB_DIR/dist" "$CONTEXT_DIR/app/web/dist"

echo "[4/5] build image"
docker build \
  --platform "$IMAGE_PLATFORM" \
  -t "$IMAGE_TAG" \
  -f "$ROOT_DIR/Dockerfile.runtime" \
  "$CONTEXT_DIR"

echo "[5/5] save image"
rm -f "$OUTPUT_PATH"
docker save -o "$OUTPUT_PATH" "$IMAGE_TAG"

echo "[verify] inspect image"
docker image inspect "$IMAGE_TAG" \
  --format 'tag={{join .RepoTags ", "}} size={{.Size}} created={{.Created}}'

echo
echo "Image archive: $OUTPUT_PATH"
