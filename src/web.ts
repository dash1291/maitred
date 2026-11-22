// maitred daemon and console. Loopback only; reached through an ssh tunnel. Every /api request carries the token
// in state/webtoken. This is the one process that opens the harness: the CLI (main.ts) talks to it over HTTP.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, LiveDoc, type EntryRecord } from "@earendil-works/pi-durable";
import { STATE_DIR } from "./config.ts";
import { bootstrap } from "./harness.ts";
import { PendingApprovals, TypingAllowances } from "./approval.ts";
import { WatchList, type WatchProof, type WatchSpec } from "./watch.ts";

const PORT = Number(process.env.MAITRED_WEB_PORT ?? 8681);
const BIND = process.env.MAITRED_WEB_BIND ?? "127.0.0.1";
const HTML = readFileSync(path.resolve(import.meta.dirname, "webui.html"), "utf8");
const context = BACKGROUND_CONTEXT;

function loadToken(): string {
  mkdirSync(STATE_DIR, { recursive: true });
  const file = path.join(STATE_DIR, "webtoken");
  if (!existsSync(file)) writeFileSync(file, randomBytes(24).toString("hex"), { mode: 0o600 });
  return readFileSync(file, "utf8").trim();
}

const token = loadToken();
const m = await bootstrap();

type Line = { who: "you" | "maitred" | "tool" | "watch"; text: string };

function linesOf(entry: EntryRecord): Line[] {
  const data = entry.data as { text?: string } | undefined;
  if (entry.kind === "maitred.user") return [{ who: "you", text: data?.text ?? "" }];
  if (entry.kind === "maitred.watch") return [{ who: "watch", text: data?.text ?? "" }];
  if (!AssistantEntry.is(entry)) return [];
  const message = entry.model?.[0];
  if (message?.role !== "assistant") return [];
  return message.content.flatMap((block): Line[] => {
    if (block.type === "text" && block.text.trim()) return [{ who: "maitred", text: block.text }];
    if (block.type === "toolCall") return [{ who: "tool", text: block.name }];
    return [];
  });
}

async function state() {
  const page = await m.root.entries({ order: "descending" }, 60, undefined, context);
  const live = await m.harness.snapshot(LiveDoc, m.root.id, context);
  return {
    model: m.model ? `${m.model.provider}/${m.model.modelId}` : null,
    busy: live?.run !== undefined,
    failure: live?.runFailure ? `${live.runFailure.reason}` : null,
    transcript: [...page.items].reverse().flatMap(linesOf),
    watches: (await m.harness.snapshot(WatchList, context))?.items ?? {},
    pending: (await m.harness.snapshot(PendingApprovals, context))?.items ?? {},
    typing: Object.fromEntries(
      Object.entries((await m.harness.snapshot(TypingAllowances, context))?.sites ?? {}).map(([site, values]) => [
        site,
        values.map((v) => v.label),
      ]),
    ),
    recipes: await m.recipes.list(),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const json = (value: unknown, code = 200) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(HTML.replace("__MAITRED_TOKEN__", token));
    }
    if (!url.pathname.startsWith("/api/")) return void json({ error: "not found" }, 404);
    if (req.headers["x-maitred-token"] !== token) return void json({ error: "bad token" }, 401);

    if (url.pathname === "/api/state" && req.method === "GET") return void json(await state());

    if (req.method !== "POST") return void json({ error: "not found" }, 404);
    const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;

    if (url.pathname === "/api/message") {
      if (typeof body.text !== "string" || !body.text.trim()) return void json({ error: "text required" }, 400);
      if (!m.model) return void json({ error: "no model configured: set MAITRED_MODEL_PROVIDER and its API key" }, 503);
      const submission = await m.say(body.text);
      if (body.wait !== true) return void json({ ok: true });
      return void json(await m.answerOf(submission));
    }

    if (url.pathname === "/api/watch") {
      const result = await m.startWatch(body.spec as WatchSpec, body.proof as WatchProof);
      return void json(result, "id" in result ? 200 : 400);
    }

    if (url.pathname === "/api/watch/stop") {
      if (typeof body.id !== "string") return void json({ error: "id required" }, 400);
      await m.stopWatch(body.id);
      return void json({ ok: true });
    }

    if (url.pathname === "/api/decide") {
      if (typeof body.id !== "string" || typeof body.allow !== "boolean") {
        return void json({ error: "id and allow required" }, 400);
      }
      const result = await m.decide(body.id, body.allow);
      return void json({ result }, result === "delivered" ? 200 : 409);
    }

    if (url.pathname === "/api/typing/forget") {
      if (typeof body.site !== "string") return void json({ error: "site required" }, 400);
      await m.forgetTyping(body.site);
      return void json({ ok: true });
    }

    return void json({ error: "not found" }, 404);
  } catch (e) {
    return void json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

server.listen(PORT, BIND, () => {
  console.log(`[maitred] console at http://${BIND}:${PORT} (token in state/webtoken), model ${m.model?.modelId ?? "none"}`);
});

process.on("SIGTERM", () => {
  server.close();
  void m.close().finally(() => process.exit(0));
});
