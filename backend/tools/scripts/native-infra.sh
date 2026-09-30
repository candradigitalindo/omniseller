#!/usr/bin/env bash
# Local PostgreSQL and Redis without Docker, using binaries on PATH (for example Homebrew).
# Same ports as infra/docker/compose.local.yml, so .env.example works for both.
#
#   pnpm infra:native start|stop|status
#
# Data lives in .local/ (git-ignored). PostgreSQL 15 or newer is required (NULLS NOT DISTINCT,
# ON DELETE SET NULL (column)); production runs 17.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DATA="${OMNISELLER_LOCAL_DIR:-$ROOT/.local}"
PG_PORT="${PG_PORT:-5433}"
REDIS_QUEUE_PORT="${REDIS_QUEUE_PORT:-6379}"
REDIS_CACHE_PORT="${REDIS_CACHE_PORT:-6380}"

pg_major() { postgres --version | sed -E 's/[^0-9]*([0-9]+).*/\1/'; }

start() {
  mkdir -p "$DATA"
  if [ "$(pg_major)" -lt 15 ]; then
    echo "PostgreSQL 15+ is required, found $(postgres --version)" >&2
    exit 1
  fi
  if [ ! -d "$DATA/pg" ]; then
    initdb -D "$DATA/pg" -U postgres --auth=trust --encoding=UTF8 --locale=C >/dev/null
  fi
  if ! pg_ctl -D "$DATA/pg" status >/dev/null 2>&1; then
    pg_ctl -D "$DATA/pg" -l "$DATA/pg.log" -w \
      -o "-p $PG_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start >/dev/null
  fi
  for port in "$REDIS_QUEUE_PORT" "$REDIS_CACHE_PORT"; do
    if ! redis-cli -p "$port" ping >/dev/null 2>&1; then
      if [ "$port" = "$REDIS_QUEUE_PORT" ]; then persist=(--appendonly yes); else persist=(--appendonly no --save ""); fi
      redis-server --port "$port" --bind 127.0.0.1 --dir "$DATA" --dbfilename "redis-$port.rdb" \
        --appendfilename "redis-$port.aof" "${persist[@]}" --daemonize yes --logfile "$DATA/redis-$port.log"
    fi
  done
  status
  echo
  echo "Next: cp .env.example .env.local && pnpm db:bootstrap && pnpm db:migrate"
  echo "Tests: TEST_PG_ADMIN_URL=postgres://postgres@127.0.0.1:$PG_PORT/postgres TEST_REDIS_URL=redis://127.0.0.1:$REDIS_QUEUE_PORT pnpm test:int"
}

stop() {
  pg_ctl -D "$DATA/pg" -m fast stop >/dev/null 2>&1 || true
  for port in "$REDIS_QUEUE_PORT" "$REDIS_CACHE_PORT"; do redis-cli -p "$port" shutdown nosave >/dev/null 2>&1 || true; done
  echo "stopped"
}

status() {
  if pg_ctl -D "$DATA/pg" status >/dev/null 2>&1; then echo "postgres  127.0.0.1:$PG_PORT  up"; else echo "postgres  down"; fi
  for port in "$REDIS_QUEUE_PORT" "$REDIS_CACHE_PORT"; do
    if redis-cli -p "$port" ping >/dev/null 2>&1; then echo "redis     127.0.0.1:$port  up"; else echo "redis     :$port  down"; fi
  done
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 1 ;;
esac
