#!/bin/bash
# maitred deploy — one command, run from the repo root on your Mac.
# rsyncs the project (without deps/state/secrets) to the server and runs
# docker compose build/up there. Everything is unprivileged (dev user on
# the box). The only privileged step ever needed is adding dev to the
# docker group, which the script checks for and prints instructions.
set -euo pipefail

HOST="${MAITRED_HOST:-dev@server.example}"
DEST_DIR="\$HOME/maitred"
SERVER_NAME="server"

say() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

command -v rsync >/dev/null || fail "rsync not found"
command -v ssh >/dev/null || fail "ssh not found"

say "host: $HOST  target: $SERVER_NAME:~/maitred"

# ---------------- checks on the server ----------------
say "checking server access and docker permissions..."
if ! OUT=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" '
  docker ps >/dev/null 2>&1 && echo "docker: ok" || echo "docker: noaccess"
  docker compose version --short 2>/dev/null | xargs echo "compose:" || echo "compose: missing"
  hostname
' 2>&1); then
  fail "cannot SSH to $HOST — check connectivity"
fi
echo "$OUT"

if grep -q "docker: noaccess" <<<"$OUT"; then
  cat >&2 <<EOF

I'm in, as user $(ssh -o BatchMode=yes "$HOST" 'id -un' 2>/dev/null || echo '?'), but permission
on the docker socket was denied. One-time privileged fix (needs your sudo password):

    ssh -t $HOST 'sudo usermod -aG docker $USER'

then log out/in (newgrp docker also works) and rerun this script.
EOF
  fail "docker access missing"
fi
if grep -q "compose: missing" <<<"$OUT"; then
  fail "docker compose plugin missing on server (needs admin install; report back and we adapt)"
fi

# ---------------- secrets ----------------
say "ensuring .env on server (never copied from here)..."
if ! ssh -o BatchMode=yes "$HOST" 'test -f ~/maitred/.env'; then
  ssh -o BatchMode=yes "$HOST" 'mkdir -p ~/maitred && touch ~/maitred/.env && chmod 600 ~/maitred/.env'
  cat >&2 <<EOF

Created an empty ~/maitred/.env on the server. Fill it in now (chmod 600 is set):

    ssh $HOST 'vi ~/maitred/.env'

Template:
    MAITRED_MODEL_PROVIDER=doubleword
    DOUBLEWORD_API_KEY=<your personal key>

Rerun this script afterwards. (Watch-only mode with no key also works.)
EOF
  fail "secrets not configured yet"
fi

# ---------------- sync + build + run ----------------
say "rsyncing project (no node_modules, no state, no secrets)..."
rsync -az --delete \
  --exclude node_modules --exclude state --exclude .env --exclude .git \
  ./ "$HOST:~/maitred/"

say "building image on server..."
ssh -o BatchMode=yes "$HOST" 'cd ~/maitred && docker compose build --pull 2>&1 | tail -3'

say "starting daemon (restart: unless-stopped)..."
ssh -o BatchMode=yes "$HOST" 'cd ~/maitred && docker compose up -d && mkdir -p state'

say "logs (ctrl-c to detach; container keeps running):"
ssh -o BatchMode=yes "$HOST" 'cd ~/maitred && timeout 15 docker compose logs --tail 15 -f || true'

say "done. daemon is running: $SERVER_NAME:maitred — crash/reboot safe via restart policy + durable resume."
