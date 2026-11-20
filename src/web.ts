// maitred web console: loopback-only, used through an ssh -L tunnel.
// Zero deps (node:http). UI polls /api/state every 2s. Loose token auth:
// every /api request must carry state/webtoken (random hex, generated once,
// lives next to the SQLite db so it survives container rebuilds).

import http from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { bootstrap, startWatch } from "./harness.ts";
import { fetchRestaurant } from "./connectors/airmenus.ts";
import { Requests } from "./docs.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import type { WatchResult } from "./tasks/watch.ts";

const PORT = Number(process.env.MAITRED_WEB_PORT ?? 8681);
// In Docker, published ports arrive via the container's eth interface, so we
// must bind 0.0.0.0 there; the host-level exposure is still loopback-only
// (compose maps 127.0.0.1:8681 -> container). Bare-metal default stays loopback.
const BIND = process.env.MAITRED_WEB_BIND ?? "127.0.0.1";
const STATE_DIR = path.resolve(process.cwd(), "state");
const HTML = readFileSync(path.resolve(import.meta.dirname, "webui.html"), "utf8");

function loadToken(): string {
  const tokPath = path.join(STATE_DIR, "webtoken");
  if (!existsSync(tokPath)) {
    const t = randomBytes(24).toString("hex");
    writeFileSync(tokPath, t, { mode: 0o600 });
    return t;
  }
  return readFileSync(tokPath, "utf8").trim();
}

const m = await bootstrap();
const bootToken = loadToken(); // eagerly create state/webtoken on boot
void bootToken;

// One live value of the task graph (used for state polls; cheap).
interface GraphTask {
  id: number;
  kind: string;
  state: { status: string; until?: number };
}
async function graphOnce(): Promise<Record<string, number>> {
  const context = BACKGROUND_CONTEXT;
  const g = await m.harness.watchTaskGraph(context);
  return new Promise((resolve) => {
    void g.start(async (call) => {
      if (call.kind === "value") {
        const tasks = (call.value.tasks ?? {}) as Record<string, GraphTask>;
        const out: Record<string, number> = {};
        for (const t of Object.values(tasks)) out[String(t.id)] = t.state.status === "terminal" ? 2 : 1;
        resolve(out);
        void g.stop();
      }
    });
  });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

interface WatchPost {
  recipe: string;
  dates: string[];
  times: string[];
  pax: number;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const token = loadToken();
  const json = (o: unknown, code = 200) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(o));
  };

  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = HTML.replace("__MAITRED_TOKEN__", token);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(html);
    }

    if (!url.pathname.startsWith("/api/")) return void json({ error: "not found" }, 404);
    const hdr = req.headers["x-maitred-token"];
    if (hdr !== token) return void json({ error: "bad token" }, 401);

    const context = BACKGROUND_CONTEXT;

    if (url.pathname === "/api/state" && req.method === "GET") {
      const requests = await m.harness.snapshot(Requests, context);
      const alive = await graphOnce();
      return void json({ requests: requests ?? {}, alive, status: "ok", pollSeconds: 4 });
    }

    if (url.pathname === "/api/watch" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as WatchPost;
      if (!body.dates?.length || !body.times?.length || !body.pax) {
        return void json({ error: "dates, times, pax all required" }, 400);
      }
      const rest = await fetchRestaurant(body.recipe);
      const outletId = rest.outlets[0]!.id;
      const requestId = "req-" + Date.now();
      const taskId: TaskId<WatchResult> = await startWatch(m, {
        requestId,
        outletId,
        dates: body.dates,
        times: body.times,
        pax: body.pax,
        pollSeconds: 4,
        giveUpAt: Date.now() + 6 * 60 * 60 * 1000,
      });
      return void json({ ok: true, requestId, taskId: String(taskId) });
    }

    if (url.pathname === "/api/cancel" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as { id: string };
      const requests = await m.harness.snapshot(Requests, context);
      const req2 = (requests as Record<string, { taskId?: string; status: string }>)?.[body.id];
      if (!req2) return void json({ error: "unknown request" }, 404);
      if (req2.taskId) {
        const tid = Number(req2.taskId);
        // live graph check: only abort if the task exists and isn't terminal
        const res2 = await m.harness.abortTask(tid as TaskId<WatchResult>, context);
        void res2; // "marked" | "terminal"; either is what we want
      }
      // one more commit to mark the request cancelled in the doc
      await m.root.commit(async (tx) => {
        const all = await tx.doc(Requests);
        if (all[body.id]) all[body.id].status = "cancelled";
      }, context);
      return void json({ ok: true });
    }

    return void json({ error: "not found" }, 404);
  } catch (e) {
    return void json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

server.listen(PORT, BIND, () => {
  console.log("[maitred] web console at http://" + BIND + ":" + PORT + " (token: state/webtoken)");
});

// keep alive alongside the durable scheduler
setInterval(() => {}, 1 << 30);
