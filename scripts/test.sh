#!/bin/sh
# Test runner: picks a Node >= 22 runtime for tsx --test.
# Why: better-sqlite3's prebuilt N-API addon segfaults Node 20.19.x inside
# napi_module_register_by_symbol (lldb-verified); the production server runs
# Homebrew Node 26 which loads it fine. Source rebuild is broken upstream
# (gyp emits empty target rules), so we require Node >= 22 instead.
set -e
for cand in /opt/homebrew/bin/node "$(command -v node)"; do
  [ -x "$cand" ] || continue
  major=$("$cand" -p 'Number(process.versions.node.split(".")[0])')
  if [ "$major" -ge 22 ]; then
    exec "$cand" node_modules/tsx/dist/cli.mjs --test test/*.test.ts
  fi
done
echo "error: tests need Node >= 22 (better-sqlite3 prebuilt N-API addon segfaults Node 20.19.x)" >&2
exit 1
