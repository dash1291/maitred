// maitred CLI: a client of the running daemon (src/web.ts). It never opens the database itself, so it cannot
// contend with the daemon for it.
//
//   main.ts say <message...>      send a message and print the answer
//   main.ts watch <file.json>     start a watch without the model; the file is { "spec": {...}, "proof": {...} }
//   main.ts stop <watchId>
//   main.ts approve|decline <requestId>
//   main.ts state

import { readFileSync } from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./config.ts";

const BASE = process.env.MAITRED_URL ?? `http://127.0.0.1:${process.env.MAITRED_WEB_PORT ?? 8681}`;
const token = process.env.MAITRED_TOKEN ?? readFileSync(path.join(STATE_DIR, "webtoken"), "utf8").trim();

async function api(pathname: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-maitred-token": token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify(value, null, 2));
    process.exit(1);
  }
  return value;
}

const [command, ...rest] = process.argv.slice(2);
const print = (value: unknown) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));

if (command === "say" && rest.length > 0) {
  const answer = (await api("/api/message", { text: rest.join(" "), wait: true })) as { ok: boolean; text?: string; reason?: string };
  print(answer.ok ? answer.text : `no answer: ${answer.reason}`);
} else if (command === "watch" && rest[0]) {
  print(await api("/api/watch", JSON.parse(readFileSync(rest[0], "utf8"))));
} else if (command === "stop" && rest[0]) {
  print(await api("/api/watch/stop", { id: rest[0] }));
} else if ((command === "approve" || command === "decline") && rest[0]) {
  print(await api("/api/decide", { id: rest[0], allow: command === "approve" }));
} else if (command === "state") {
  print(await api("/api/state"));
} else {
  console.error("usage: main.ts say <message> | watch <file.json> | stop <id> | approve <id> | decline <id> | state");
  process.exit(1);
}
