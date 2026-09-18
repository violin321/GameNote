#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
  echo "Refusing to run GameNote NS2 as root." >&2
  exit 1
fi

if [ "${APP_DATABASE_FILE:-}" != "/data/ns2.sqlite" ]; then
  echo "APP_DATABASE_FILE must be /data/ns2.sqlite in the container." >&2
  exit 1
fi

if ! touch /data/.write-test 2>/dev/null; then
  echo "The NS2 data directory is not writable by UID:GID $(id -u):$(id -g)." >&2
  exit 1
fi
rm -f /data/.write-test

node scripts/migrate-play-history.mjs
exec node scripts/container-runtime.mjs "$@"
