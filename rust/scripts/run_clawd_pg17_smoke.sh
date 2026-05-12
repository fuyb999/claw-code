#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

port="${CLAWD_SMOKE_PORT:-33210}"
pg_port="${CLAWD_SMOKE_PG_PORT:-55432}"
container_name="clawd-pg17-smoke-${RANDOM}${RANDOM}"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/clawd-pg17-smoke.XXXXXX")"
clawd_log="$tmp_dir/clawd.log"
clawd_pid=""

cleanup() {
  local exit_code=$?
  if [[ -n "$clawd_pid" ]] && kill -0 "$clawd_pid" >/dev/null 2>&1; then
    kill "$clawd_pid" >/dev/null 2>&1 || true
    wait "$clawd_pid" >/dev/null 2>&1 || true
  fi
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  if [[ $exit_code -ne 0 && -f "$clawd_log" ]]; then
    printf '\nclawd smoke failed; recent clawd log:\n' >&2
    tail -n 200 "$clawd_log" >&2 || true
  fi
  rm -rf "$tmp_dir"
  exit "$exit_code"
}
trap cleanup EXIT

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

require_command docker
require_command curl
require_command python3
require_command cargo

docker run -d --rm \
  --name "$container_name" \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=clawd \
  -p "${pg_port}:5432" \
  postgres:17 >/dev/null

until docker exec "$container_name" pg_isready -U postgres -d clawd >/dev/null 2>&1; do
  sleep 1
done

CLAWD_BIND_ADDR="127.0.0.1:${port}" \
CLAWD_DATA_DIR="$tmp_dir/data" \
CLAWD_ALLOWED_ROOTS="$repo_root" \
CLAWD_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${pg_port}/clawd" \
CLAWD_BOOTSTRAP_API_KEYS="tenant-a:alice:smoke-bootstrap-key:Smoke Bootstrap" \
CLAWD_MAX_THREADS_PER_USER=1 \
CLAWD_MAX_MUTATION_REQUESTS_PER_MINUTE_PER_USER=5 \
cargo run --manifest-path rust/Cargo.toml -p clawd >"$clawd_log" 2>&1 &
clawd_pid=$!

until curl -fsS "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; do
  sleep 1
done

config_json="$(curl -fsS "http://127.0.0.1:${port}/v1/config")"
python3 - <<'PY' "$config_json"
import json, sys
payload = json.loads(sys.argv[1])
assert payload["database_backend"] == "postgres", payload
assert payload["database_schema_version"] >= 5, payload
assert payload["max_threads_per_user"] == 1, payload
assert payload["max_mutation_requests_per_minute_per_user"] == 5, payload
PY

session_json="$(curl -fsS -H 'Authorization: Bearer smoke-bootstrap-key' "http://127.0.0.1:${port}/v1/auth/session")"
python3 - <<'PY' "$session_json"
import json, sys
payload = json.loads(sys.argv[1])
assert payload["auth_mode"] == "api_key", payload
assert payload["tenant_id"] == "tenant-a", payload
assert payload["user_id"] == "alice", payload
PY

api_keys_json="$(curl -fsS -H 'Authorization: Bearer smoke-bootstrap-key' "http://127.0.0.1:${port}/v1/api-keys")"
python3 - <<'PY' "$api_keys_json"
import json, sys
payload = json.loads(sys.argv[1])
assert len(payload["api_keys"]) == 1, payload
assert payload["api_keys"][0]["display_name"] == "Smoke Bootstrap", payload
PY

created_key_json="$(curl -fsS -X POST \
  -H 'Authorization: Bearer smoke-bootstrap-key' \
  -H 'Content-Type: application/json' \
  -d '{"display_name":"Smoke Browser"}' \
  "http://127.0.0.1:${port}/v1/api-keys")"
created_key_id="$(python3 - <<'PY' "$created_key_json"
import json, sys
payload = json.loads(sys.argv[1])
assert payload["api_key"]["display_name"] == "Smoke Browser", payload
assert payload["raw_key"].startswith("ck_"), payload
print(payload["api_key"]["id"])
PY
)"
created_raw_key="$(python3 - <<'PY' "$created_key_json"
import json, sys
payload = json.loads(sys.argv[1])
print(payload["raw_key"])
PY
)"

bootstrap_key_id="$(python3 - <<'PY' "$session_json"
import json, sys
payload = json.loads(sys.argv[1])
print(payload["api_key_id"])
PY
)"

curl -fsS -X POST \
  -H "Authorization: Bearer ${created_raw_key}" \
  "http://127.0.0.1:${port}/v1/api-keys/${bootstrap_key_id}/disable" >/dev/null

disabled_status="$(curl -s -o "$tmp_dir/bootstrap-disabled.out" -w '%{http_code}' \
  -H 'Authorization: Bearer smoke-bootstrap-key' \
  "http://127.0.0.1:${port}/v1/auth/session")"
[[ "$disabled_status" == "401" ]]

thread_json="$(curl -fsS -X POST \
  -H "Authorization: Bearer ${created_raw_key}" \
  -H 'Content-Type: application/json' \
  -d "{\"workspace_root\":\"${repo_root}\",\"topic\":\"smoke thread\"}" \
  "http://127.0.0.1:${port}/v1/threads")"
python3 - <<'PY' "$thread_json"
import json, sys
payload = json.loads(sys.argv[1])
assert payload["topic"] == "smoke thread", payload
assert payload["audit_records"][0]["kind"] == "thread_created", payload
PY

thread_limit_status="$(curl -s -o "$tmp_dir/thread-limit.out" -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer ${created_raw_key}" \
  -H 'Content-Type: application/json' \
  -d "{\"workspace_root\":\"${repo_root}\",\"topic\":\"should fail\"}" \
  "http://127.0.0.1:${port}/v1/threads")"
[[ "$thread_limit_status" == "429" ]]
python3 - <<'PY' "$tmp_dir/thread-limit.out"
import json, pathlib, sys
payload = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert "thread limit reached" in payload["error"], payload
PY

current_key_disable_status="$(curl -s -o "$tmp_dir/current-key-disable.out" -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer ${created_raw_key}" \
  "http://127.0.0.1:${port}/v1/api-keys/${created_key_id}/disable")"
[[ "$current_key_disable_status" == "400" ]]

thread_id="$(python3 - <<'PY' "$thread_json"
import json, sys
payload = json.loads(sys.argv[1])
print(payload["id"])
PY
)"

mutation_limit_status="$(curl -s -o "$tmp_dir/mutation-limit.out" -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer ${created_raw_key}" \
  -H 'Content-Type: application/json' \
  -d '{"type":"user_message","content":"rate limit check"}' \
  "http://127.0.0.1:${port}/v1/threads/${thread_id}/commands")"
[[ "$mutation_limit_status" == "429" ]]
python3 - <<'PY' "$tmp_dir/mutation-limit.out"
import json, pathlib, sys
payload = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert "mutation rate limit reached" in payload["error"], payload
PY

echo "clawd PostgreSQL 17 smoke passed"
