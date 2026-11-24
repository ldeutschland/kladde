set -eu
: "${TEST_DATABASE_URL:?Set TEST_DATABASE_URL to an empty disposable PostgreSQL database}"
work=$(mktemp -d)
port=${KLADDE_TEST_PORT:-17341}
export DATABASE_URL="$TEST_DATABASE_URL" OPAQUE_SETUP_FILE="$work/setup" BLOB_DIR="$work/blobs" LISTEN_ADDR="127.0.0.1:$port" ACCOUNT_QUOTA_BYTES=8388608
cargo build --locked -p kladde-server
binary="${CARGO_TARGET_DIR:-target}/debug/kladde-server"
"$binary" init-setup "$OPAQUE_SETUP_FILE"
"$binary" > "$work/relay.log" 2>&1 &
relay_pid=$!
trap 'kill "$relay_pid" 2>/dev/null || true; wait "$relay_pid" 2>/dev/null || true; rm -rf "$work"' EXIT
export KLADDE_TEST_RELAY="http://127.0.0.1:$port/"
for i in $(seq 1 80); do
  if curl -fsS "${KLADDE_TEST_RELAY}health" -o /dev/null 2>/dev/null; then break; fi
  sleep .25
done
cargo test --locked -p kladde-sync --test relay -- --ignored
cargo test --locked -p kladde-sync --test compat -- --ignored
cargo test --locked -p kladde-sync --features loopback-test --test engine -- --ignored
if [ -n "${KLADDE_PG_TEST_CONTAINER:-}" ]; then
  docker exec "$KLADDE_PG_TEST_CONTAINER" pg_dump --data-only -U postgres -d postgres > "$work/dump"
else
  pg_dump --data-only "$TEST_DATABASE_URL" > "$work/dump"
fi
test -s "$work/dump"
if grep -aqE 'KLADDE_PRIVATE_CANARY_84191|zweite Notiz|test-only-long-password|Offline am iPhone|offline ergänzt|Nach Erneuerung|ruhig|eins zwei|Seite 3 neu|vom Telefon|eigen neu|fremd neu|phone3|wiederbelebt|bleibt liegen|geht raus|im Verzeichnis|nur das Neue|unterwegs ergänzt|während des Abrufs|zurückgeholt|vor dem Wechsel|nur am Telefon|und ergänzt|ungesichert|überlebt den Wechsel|im neuen Konto gelöscht|unterwegs gerettet|xxxxxxxxxxxxxxxx' "$work/dump"; then exit 1; fi
