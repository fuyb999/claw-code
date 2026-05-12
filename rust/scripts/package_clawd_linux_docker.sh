#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUST_DIR="$ROOT_DIR/rust"
WEB_DIR="$ROOT_DIR/web"
RELEASE_DIR="$ROOT_DIR/release"
VERSION="${1:-$(date +%Y%m%d-%H%M%S)}"
PACKAGE_NAME="clawd-web-agent-linux-x64-${VERSION}"
PACKAGE_DIR="$RELEASE_DIR/$PACKAGE_NAME"
ARCHIVE_PATH="$RELEASE_DIR/${PACKAGE_NAME}.tar.gz"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

mkdir -p "$RELEASE_DIR"
rm -rf "$PACKAGE_DIR" "$ARCHIVE_PATH"

echo "[1/5] build web"
(cd "$WEB_DIR" && npm run build)

echo "[2/5] build linux clawd in docker"
docker run --rm \
  --platform linux/amd64 \
  -v "$RUST_DIR:/work" \
  -w /work \
  rust:1.81 \
  bash -lc 'cargo build --release -p clawd'

echo "[3/5] assemble package"
mkdir -p "$PACKAGE_DIR/bin" "$PACKAGE_DIR/web" "$PACKAGE_DIR/scripts" "$PACKAGE_DIR/data"
cp "$RUST_DIR/target/release/clawd" "$PACKAGE_DIR/bin/clawd"
chmod +x "$PACKAGE_DIR/bin/clawd"
cp -R "$WEB_DIR/dist" "$PACKAGE_DIR/web/dist"

cat > "$PACKAGE_DIR/scripts/start-clawd.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

export CLAWD_BIND_ADDR="${CLAWD_BIND_ADDR:-0.0.0.0:3210}"
export CLAWD_DATA_DIR="${CLAWD_DATA_DIR:-$APP_DIR/data}"
export CLAWD_WEB_DIST_DIR="${CLAWD_WEB_DIST_DIR:-$APP_DIR/web/dist}"

mkdir -p "$CLAWD_DATA_DIR"
exec "$APP_DIR/bin/clawd"
EOF
chmod +x "$PACKAGE_DIR/scripts/start-clawd.sh"

cat > "$PACKAGE_DIR/README.txt" <<'EOF'
Clawd Web Agent Linux package

Start:
  ./scripts/start-clawd.sh

This package contains:
  - Linux clawd backend binary
  - bundled frontend static files
  - startup helper script
EOF

echo "[4/5] verify artifact"
file "$PACKAGE_DIR/bin/clawd"

echo "[5/5] archive"
tar -C "$RELEASE_DIR" -czf "$ARCHIVE_PATH" "$PACKAGE_NAME"

echo
echo "Package directory: $PACKAGE_DIR"
echo "Archive: $ARCHIVE_PATH"
