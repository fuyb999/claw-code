#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUST_DIR="$ROOT_DIR/rust"
WEB_DIR="$ROOT_DIR/web"
OUT_DIR="$ROOT_DIR/release/clawd-linux-x64"
APP_DIR="$OUT_DIR/app"
WEB_DIST_DIR="$WEB_DIR/dist"
VERSION="${1:-$(date +%Y%m%d-%H%M%S)}"
ARCHIVE_BASENAME="clawd-web-agent-linux-x64-${VERSION}"
ARCHIVE_DIR="$ROOT_DIR/release/$ARCHIVE_BASENAME"
ARCHIVE_PATH="$ROOT_DIR/release/${ARCHIVE_BASENAME}.tar.gz"

rm -rf "$OUT_DIR" "$ARCHIVE_DIR"
mkdir -p "$APP_DIR/bin" "$APP_DIR/web" "$APP_DIR/scripts" "$APP_DIR/data"

echo "[1/4] build web"
(cd "$WEB_DIR" && npm run build)

echo "[2/4] build clawd release"
(cd "$RUST_DIR" && cargo build --release -p clawd)

echo "[3/4] assemble package"
cp "$RUST_DIR/target/release/clawd" "$APP_DIR/bin/clawd"
chmod +x "$APP_DIR/bin/clawd"
rm -rf "$APP_DIR/web/dist"
cp -R "$WEB_DIST_DIR" "$APP_DIR/web/dist"

cat > "$APP_DIR/scripts/start-clawd.sh" <<'EOF'
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
chmod +x "$APP_DIR/scripts/start-clawd.sh"

cat > "$APP_DIR/README.txt" <<'EOF'
Clawd Web Agent Linux package

Start:
  ./scripts/start-clawd.sh

Default bind:
  http://0.0.0.0:3210

Useful environment variables:
  CLAWD_BIND_ADDR=0.0.0.0:3210
  CLAWD_DATA_DIR=/path/to/data
  CLAWD_WEB_DIST_DIR=/path/to/web/dist
  CLAWD_DATABASE_URL=postgresql://...
  CLAWD_DEFAULT_MODEL=...
  OPENAI_BASE_URL=...
  OPENAI_API_KEY=...
  OPENAI_MODEL=...

The frontend static files are already bundled under:
  web/dist
EOF

echo "[4/4] archive package"
mkdir -p "$ROOT_DIR/release"
cp -R "$APP_DIR" "$ARCHIVE_DIR"
tar -C "$ROOT_DIR/release" -czf "$ARCHIVE_PATH" "$ARCHIVE_BASENAME"

echo
echo "Package directory: $APP_DIR"
echo "Archive: $ARCHIVE_PATH"
