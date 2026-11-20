# maitred on server (dev@server.example)

Deploy: `./deploy.sh` from repo root. Container `maitred` runs headless
(`daemon` mode) under `docker compose`, restart=unless-stopped, outbound-only
(no published ports), uid 1000, state in `~/maitred/state` (bind mount).

## Ops
- logs: ssh dev@server.example 'cd ~/maitred && docker compose logs -f'
- update: edit locally, ./deploy.sh (rsync + rebuild + up -d)
- secrets: ~/maitred/.env (600) — MAITRED_MODEL_PROVIDER + key
- crash test: docker exec maitred node -e 'process.kill(1,"SIGKILL")' —
  it should auto-restart and resume() state from SQLite.
- `docker compose kill/stop` = explicit stop; restart policy is *skipped*
  for manual ops. Use `up -d` again to resume.
