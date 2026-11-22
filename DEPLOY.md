# Deploying maitred

`./deploy.sh` syncs the source to a server and runs it there under Docker
Compose: container `maitred` runs `src/web.ts` (daemon and console in one
process), restart=unless-stopped, uid 1000, state in `~/maitred/state` (bind
mount). The console is published on the server's loopback only.

Tell the script which server, as `user@host`: set `MAITRED_HOST`, or put
`MAITRED_HOST=user@host` in a file named `deploy.local` next to the script
(it is gitignored). The server needs Docker with the Compose plugin, and a
`~/maitred/.env` holding the settings from the README.

## Ops
- console: `ssh -L 18681:127.0.0.1:8681 $MAITRED_HOST`, then
  http://127.0.0.1:18681
- CLI through the tunnel: `MAITRED_URL=http://127.0.0.1:18681 MAITRED_TOKEN=<state/webtoken> node --experimental-strip-types src/main.ts state`
- logs: `ssh $MAITRED_HOST 'cd ~/maitred && docker compose logs -f'`
- update: edit locally, `./deploy.sh` (rsync, rebuild, up -d)
- crash test: `docker exec maitred node -e 'process.kill(1,"SIGKILL")'`;
  it restarts and resumes its watches from SQLite.
- `docker compose kill/stop` is an explicit stop; the restart policy is
  skipped for manual stops. Use `up -d` again to resume.
- Do not run a second process on the database inside the container. Use the
  console or the CLI, which talk to the daemon over HTTP.
