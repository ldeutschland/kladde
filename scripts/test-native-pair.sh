set -eu
: "${TEST_DATABASE_URL:?Use an isolated disposable PostgreSQL database}"
: "${KLADDE_QA_DIR:?Use the same private directory as build-native-pair.sh}"
q="$KLADDE_QA_DIR"
export DATABASE_URL="$TEST_DATABASE_URL" OPAQUE_SETUP_FILE="$q/opaque" BLOB_DIR="$q/blobs" LISTEN_ADDR=127.0.0.1:17446
cargo build --locked -p kladde-server
binary="${CARGO_TARGET_DIR:-target}/debug/kladde-server"
if [ ! -f "$OPAQUE_SETUP_FILE" ]; then "$binary" init-setup "$OPAQUE_SETUP_FILE"; fi
export KLADDE_QA_RELAY="$binary"
python3 tests/native/tls_relay.py "$q/server.pem" "$q/server.key" > "$q/tls-server.log" 2>&1 &
proxy=$!
trap 'kill "$proxy" 2>/dev/null || true; wait "$proxy" 2>/dev/null || true' EXIT
python3 tests/native/pair.py
pg_dump --data-only "$TEST_DATABASE_URL" > "$q/server.dump"
test -s "$q/server.dump"
if grep -aqE 'KLADDE_PRIVATE_NATIVE_CANARY|Native Pair|KLADDE_NATIVE_FILE_MARKER' "$q/server.dump"; then exit 1; fi
rm "$q/server.dump"
