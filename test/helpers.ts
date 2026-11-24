import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type JsonObject, type Storage } from "@earendil-works/pi-durable";
import { bootstrap } from "../src/harness.ts";
import type { HostPolicy } from "../src/http.ts";
import type { TelegramOptions } from "../src/telegram.ts";

export const anyHost: HostPolicy = async () => {};

export type Site = {
  url: string;
  hostname: string;
  port: number;
  requests: { method: string; path: string; body: string }[];
  close(): Promise<void>;
};

type Reply = { status?: number; json?: unknown; text?: string; html?: string; location?: string };

/** A local site whose response comes from `respond`, called for every request. */
export async function site(
  respond: (req: { method: string; path: string; body: string }) => Reply | Promise<Reply>,
  hostname = "127.0.0.1",
): Promise<Site> {
  const requests: Site["requests"] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const seen = { method: req.method ?? "", path: req.url ?? "", body };
      requests.push(seen);
      const out = await respond(seen);
      if (out.location) {
        res.writeHead(out.status ?? 302, { location: out.location });
        return void res.end();
      }
      if (out.json !== undefined) {
        res.writeHead(out.status ?? 200, { "content-type": "application/json" });
        return void res.end(JSON.stringify(out.json));
      }
      res.writeHead(out.status ?? 200, { "content-type": out.html === undefined ? "text/plain" : "text/html" });
      res.end(out.html ?? out.text ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, hostname, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${hostname}:${port}`,
    hostname,
    port,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "maitred-test-"));
}

/** A maitred whose model is scripted: `say` each reply the model should give, in order. */
export async function scripted(
  options: { storage?: Storage; dir?: string; reachable?: HostPolicy; telegram?: TelegramOptions; timezone?: string } = {},
) {
  const dir = options.dir ?? tempDir();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const m = await bootstrap({
    storage: options.storage ?? new MemoryStorage(),
    models,
    model: { provider: model.provider, modelId: model.id },
    recipeDirs: { writable: path.join(dir, "recipes"), builtin: path.join(dir, "builtin") },
    reachable: options.reachable ?? anyHost,
    timezone: options.timezone ?? "Asia/Kolkata",
    telegram: options.telegram ?? null,
  });
  return {
    m,
    dir,
    modelCalls: (name: string, args: JsonObject) =>
      faux.appendResponses([fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" })]),
    modelSays: (text: string) => faux.appendResponses([fauxAssistantMessage(text)]),
  };
}
