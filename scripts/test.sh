#!/usr/bin/env bash
# Chạy pytest trong container python:3.12 nối vào mạng compose.
# Dùng: bash scripts/test.sh tests/test_app.py -v   (đường dẫn tính từ backend/)
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

[ -f .env ] || cp .env.example .env

docker compose up -d db redis

# Chờ db và redis healthy.
for svc in db redis; do
  cid="$(docker compose ps -q "$svc")"
  for _ in $(seq 1 60); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "$cid")"
    [ "$status" = "healthy" ] && break
    sleep 2
  done
  if [ "$status" != "healthy" ]; then
    echo "Service $svc is not healthy (status: $status)" >&2
    exit 1
  fi
done

DB_CID="$(docker compose ps -q db)"

# Tạo database messaging_test nếu chưa có.
docker exec "$DB_CID" sh -c '
  if ! psql -U "$POSTGRES_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '"'"'messaging_test'"'"'" | grep -q 1; then
    createdb -U "$POSTGRES_USER" messaging_test
  fi
'

docker build -q -t kn-backend-dev -f backend/Dockerfile.dev backend >/dev/null

NET="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$DB_CID" | head -n 1)"

# Tắt chuyển đổi đường dẫn của Git Bash/MSYS trên Windows.
MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' docker run --rm --network "$NET" \
  -v "$ROOT/backend:/srv" -w /srv \
  -e TEST_DATABASE_URL=postgresql+asyncpg://messaging:messaging@db:5432/messaging_test \
  -e TEST_REDIS_URL=redis://redis:6379/1 \
  kn-backend-dev pytest "$@"
