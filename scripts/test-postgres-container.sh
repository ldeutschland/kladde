set -eu
name="kladde-qa-$(uuidgen | tr '[:upper:]' '[:lower:]')"
password=$(openssl rand -hex 20)
container=$(docker run -d --rm --name "$name" -e POSTGRES_PASSWORD="$password" -p 127.0.0.1::5432 postgres:17-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536)
trap 'docker stop "$container" >/dev/null 2>&1 || true' EXIT
for n in $(seq 1 90); do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
port=$(docker port "$container" 5432/tcp | sed 's/.*://')
export TEST_DATABASE_URL="postgresql://postgres:$password@127.0.0.1:$port/postgres" KLADDE_PG_TEST_CONTAINER="$container"
sh scripts/test-relay.sh
