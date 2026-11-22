# maitred on server (dev@server.example)

Deploy: `./deploy.sh` from repo root. Container `maitred` runs `src/web.ts`
(daemon and console in one process) under `docker compose`,
restart=unless-stopped, uid 1000, state in `~/maitred/state` (bind mount). The
console is published on the host's loopback only.

## Ops
- console: `ssh -L 18681:127.0.0.1:8681 dev@server.example`, then
  http://127.0.0.1:18681
- CLI through the tunnel: `MAITRED_URL=http://127.0.0.1:18681 MAITRED_TOKEN=<state/webtoken> node --experimental-strip-types src/main.ts state`
- logs: ssh dev@server.example 'cd ~/maitred && docker compose logs -f'
- update: edit locally, ./deploy.sh (rsync + rebuild + up -d)
- secrets: ~/maitred/.env (600): MAITRED_MODEL_PROVIDER and its key
- crash test: docker exec maitred node -e 'process.kill(1,"SIGKILL")';
  it restarts and resumes its watches from SQLite.
- `docker compose kill/stop` = explicit stop; restart policy is *skipped*
  for manual ops. Use `up -d` again to resume.
- Do not run a second process on the database inside the container. Use the
  console or the CLI, which talk to the daemon over HTTP.
