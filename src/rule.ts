import type { JsonValue } from "@earendil-works/chord/json";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { httpGet, type HostPolicy } from "./http.ts";

/** What a rule script sees as `input`. */
export type RuleInput = {
  params: JsonValue;
  /** Today's date, yyyy-mm-dd, in the watch's timezone. */
  today: string;
  now: number;
  /** For a watch that walks a page in the browser: what that page shows. */
  page?: JsonValue;
};

export type RuleOutcome = { ok: true; matches: JsonValue[] } | { ok: false; error: string };

const MAX_REQUESTS = 20;

/**
 * Run one watch rule: model-written JavaScript in a QuickJS sandbox. A browser watch's rule only reads `input.page`.
 * The older kind fetches for itself with `tools.get(url)`, limited to the hosts `allow` permits.
 * The rule returns the array of matches; an empty array means nothing is available yet.
 */
export async function runRule(
  code: string,
  input: RuleInput,
  allow: HostPolicy,
  options: { timeoutMs?: number } = {},
): Promise<RuleOutcome> {
  let requests = 0;
  const sandbox = new CodemodeSandbox({
    timeoutMs: options.timeoutMs ?? 30_000,
    memoryLimitBytes: 64 * 1024 * 1024,
    tools: [
      {
        name: "get",
        execute: async (args, { signal }) => {
          const url = typeof args === "string" ? args : (args as { url?: unknown } | null)?.url;
          if (typeof url !== "string") throw new Error("get(url) needs a URL string");
          if (++requests > MAX_REQUESTS) throw new Error(`a rule may make at most ${MAX_REQUESTS} requests per probe`);
          const res = await httpGet(url, { allow, signal, timeoutMs: 10_000, maxBytes: 2_000_000 });
          if (res.status < 200 || res.status >= 300) throw new Error(`GET ${url} -> HTTP ${res.status}`);
          return res.contentType.includes("json") ? JSON.parse(res.body) : res.body;
        },
      },
    ],
  });
  try {
    const result = await sandbox.execute(`const input = ${JSON.stringify(input)}; ${code}`);
    if (!result.ok) return { ok: false, error: `${result.error.kind}: ${result.error.message}` };
    if (!Array.isArray(result.value)) return { ok: false, error: "the rule must return an array of matches" };
    return { ok: true, matches: result.value as JsonValue[] };
  } finally {
    await sandbox.close();
  }
}
