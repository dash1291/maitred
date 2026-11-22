import type { JsonValue } from "@earendil-works/chord/json";
import { defineDoc, defineTask, type Tx } from "@earendil-works/pi-durable";
import type { PageView, Step } from "./browser.ts";
import { localDate } from "./config.ts";
import type { HostPolicy } from "./http.ts";
import { runRule, type RuleOutcome } from "./rule.ts";

/** Everything a watch needs, supplied by whoever starts it (the model, through the watch tool). */
export type WatchSpec = {
  label: string;
  /**
   * What a person does to reach the page that answers the question, replayed in a browser on every probe. Absent: the
   * older kind of watch, whose rule fetches from `hosts` itself.
   */
  steps?: Step[];
  /** Script run each probe; see `runRule`. With `steps` it reads `input.page`. */
  rule: string;
  hosts: string[];
  params: JsonValue;
  timezone: string;
  intervalSeconds: number;
  /** Epoch ms; absent: watch until stopped. */
  until?: number;
  alert: string;
  /** Why this watch started without proof that its rule can match. Shown to the person for as long as it runs. */
  unproven?: string;
  /** The assistant's note to itself: what to do the moment this matches. Handed back with the matches. */
  then?: string;
};

/** Params for which the rule matches right now: evidence that it can see availability at all. */
export type WatchProof = JsonValue | undefined;

export type WatchStatus = {
  label: string;
  alert: string;
  intervalSeconds: number;
  startedAt: number;
  state: "watching" | "matched" | "expired" | "stopped";
  probes: number;
  lastProbedAt: number;
  note: string;
  matches?: JsonValue[];
  unproven?: string;
};

export type WatchListDoc = { items: { [taskId: string]: WatchStatus } };

export const WatchList = defineDoc<WatchListDoc>({
  kind: "maitred.watchlist",
  version: 1,
  scope: "session",
  initial: () => ({ items: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 100,
});

export const MIN_INTERVAL_SECONDS = 4;
/** A browser probe is a full visit to the site, so it may not be made more than once a minute. */
export const MIN_BROWSER_INTERVAL_SECONDS = 60;
const FAILURES_BEFORE_REPORT = 3;

export function checkWatchSpec(spec: WatchSpec, now: number): string[] {
  const problems: string[] = [];
  if (!spec.label.trim()) problems.push("label is empty");
  if (!spec.rule.trim()) problems.push("rule is empty");
  if (!spec.alert.trim()) problems.push("alert is empty");
  const floor = spec.steps ? MIN_BROWSER_INTERVAL_SECONDS : MIN_INTERVAL_SECONDS;
  if (!Number.isFinite(spec.intervalSeconds) || spec.intervalSeconds < floor) {
    problems.push(`intervalSeconds must be at least ${floor}`);
  }
  if (!spec.steps) {
    if (spec.hosts.length === 0) problems.push("hosts is empty: list every host the rule fetches from");
  } else {
    if (spec.steps[0]?.action !== "open") problems.push("steps must begin by opening a URL");
    for (const [i, step] of spec.steps.entries()) {
      if (step.action !== "open" && /^\d+$/.test(step.target.trim())) {
        problems.push(`step ${i + 1}: name the target by the text a person sees; control numbers change between visits`);
      }
    }
  }
  if (spec.until !== undefined && !(spec.until > now)) problems.push("until is not in the future");
  if (spec.unproven !== undefined && !spec.unproven.trim()) problems.push("unproven is empty: say why no proof exists");
  try {
    localDate(now, spec.timezone);
  } catch {
    problems.push(`timezone ${JSON.stringify(spec.timezone)} is not an IANA timezone`);
  }
  return problems;
}

export type WatchDeps = {
  /** The policy for a rule's `get`: which hosts this watch may reach. */
  allowFor(hosts: readonly string[]): HostPolicy;
  /** Replay a watch's steps in a browser and return what the page then shows. */
  walk(steps: readonly Step[], params: JsonValue): Promise<PageView>;
  /** Tell the person about a match at once, before any model runs. */
  alert?(text: string): Promise<void>;
};

export async function probe(spec: WatchSpec, now: number, deps: WatchDeps): Promise<RuleOutcome> {
  const input = { params: spec.params, today: localDate(now, spec.timezone), now };
  if (!spec.steps) return runRule(spec.rule, input, deps.allowFor(spec.hosts));
  const steps = spec.steps;
  const visit = async (): Promise<RuleOutcome> => {
    let view: PageView;
    try {
      view = await deps.walk(steps, spec.params);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const page = { url: view.url, title: view.title, text: view.text, controls: view.controls };
    return runRule(spec.rule, { ...input, page }, deps.allowFor([]));
  };
  // A page that was slow to respond once is visited once more before the probe counts as failed.
  const first = await visit();
  return first.ok ? first : visit();
}

/**
 * The checks every watch passes before it starts. A rule that runs cleanly and returns nothing proves nothing: a wrong
 * endpoint or a misread response looks exactly like "not available yet". So besides a valid spec and a clean first run
 * that does not already match, the rule must be seen to match `proof` params now, unless the spec says why no such
 * case exists. Returns why the watch must not start, or null.
 */
export async function vetWatch(
  spec: WatchSpec,
  proof: WatchProof,
  now: number,
  deps: WatchDeps,
): Promise<{ refusal: string; isError: boolean } | null> {
  const problems = checkWatchSpec(spec, now);
  if (proof === undefined && spec.unproven === undefined) {
    problems.push(
      "proof is missing: give params for which the rule matches right now (another date, party size or venue that " +
        "the page itself shows as available), or set unproven to the reason no such case exists",
    );
  }
  if (problems.length > 0) return { refusal: `Not started:\n${problems.join("\n")}`, isError: true };
  if (proof !== undefined) {
    const shown = await probe({ ...spec, params: proof }, now, deps);
    if (!shown.ok) return { refusal: `Not started. The rule failed on the proof params:\n${shown.error}`, isError: true };
    if (shown.matches.length === 0) {
      return {
        refusal:
          "Not started: the rule found nothing for the proof params, so it has not been shown to detect availability. " +
          "An empty result here usually means the request or the way the response is read is wrong, not that nothing " +
          "is available. Open the page in the browser, find something it shows as available, and make the rule return it.",
        isError: true,
      };
    }
  }
  const first = await probe(spec, now, deps);
  if (!first.ok) return { refusal: `Not started. The rule failed its first run:\n${first.error}`, isError: true };
  if (first.matches.length > 0) {
    return { refusal: `Not started: the rule already matches.\n${JSON.stringify(first.matches)}`, isError: false };
  }
  return null;
}

/** List a watch from the moment it starts; its first probe replaces this entry. */
export async function listNewWatch(tx: Tx, id: string, spec: WatchSpec, now: number): Promise<void> {
  const list = await tx.doc(WatchList);
  list.items[id] ??= {
    label: spec.label,
    alert: spec.alert,
    intervalSeconds: spec.intervalSeconds,
    startedAt: now,
    state: "watching",
    probes: 0,
    lastProbedAt: now,
    note: "starting",
    ...(spec.unproven ? { unproven: spec.unproven } : {}),
  };
}

export const WATCH_TASK_OPTIONS = {
  ownership: { kind: "conversation" },
  background: true,
  abandonOnRestart: false,
} as const;

type WatchCheckpoint = { phase: "probe"; probes: number; failures: number; startedAt: number };
export type WatchResult = { state: "matched" | "expired"; matches?: JsonValue[] };

export function createWatchTask(deps: WatchDeps) {
  return defineTask<WatchSpec, WatchCheckpoint, WatchResult>({
    name: "maitred.watch",
    version: 1,
    initial: () => ({ phase: "probe", probes: 0, failures: 0, startedAt: 0 }),
    phases: {
      probe: async (task, runtime, context) => {
        const spec = task.input;
        const now = runtime.now();
        const outcome = await probe(spec, now, deps);

        const probes = task.state.checkpoint.probes + 1;
        const startedAt = task.state.checkpoint.startedAt || now;
        const failures = outcome.ok ? 0 : task.state.checkpoint.failures + 1;
        const matches = outcome.ok ? outcome.matches : [];
        const matched = matches.length > 0;
        const expired = !matched && spec.until !== undefined && now >= spec.until;

        let report: string | undefined;
        if (matched) {
          report = `Watch matched: ${spec.label}\n${spec.alert}\nMatches: ${JSON.stringify(matches)}`;
          if (spec.then) report += `\nYour note for this moment: ${spec.then}`;
        }
        else if (expired) report = `Watch ended at its deadline without a match: ${spec.label}`;
        else if (!outcome.ok && failures === FAILURES_BEFORE_REPORT) {
          report = `Watch rule has failed ${failures} probes in a row: ${spec.label}\n${outcome.error}\nIt keeps polling.`;
        }
        if (matched) {
          console.log(`[maitred] ALERT ${spec.label}: ${spec.alert} ${JSON.stringify(matches)}`);
          await deps.alert?.(`${spec.alert}\n\n${spec.label}\n${JSON.stringify(matches)}`);
        }

        const conversation = report ? await runtime.conversation(runtime.conversationId, context) : undefined;
        await runtime.commit(async (tx) => {
          if (report && conversation) {
            await conversation.submit(tx, {
              type: "input",
              content: report,
              requestId: `watch:${task.id}:${probes}`,
              entry: { kind: "maitred.watch", data: { taskId: String(task.id), text: report } },
            });
          }
          const list = await tx.doc(WatchList);
          list.items[String(task.id)] = {
            label: spec.label,
            alert: spec.alert,
            intervalSeconds: spec.intervalSeconds,
            startedAt,
            state: matched ? "matched" : expired ? "expired" : "watching",
            probes,
            lastProbedAt: now,
            note: outcome.ok ? (matched ? "matched" : "no match") : outcome.error,
            ...(matched ? { matches } : {}),
            ...(spec.unproven ? { unproven: spec.unproven } : {}),
          };
          if (matched) {
            return { status: "terminal", outcome: { status: "completed", result: { state: "matched", matches } } };
          }
          if (expired) {
            return { status: "terminal", outcome: { status: "completed", result: { state: "expired" } } };
          }
          return {
            status: "sleeping",
            until: now + spec.intervalSeconds * 1000,
            checkpoint: { phase: "probe", probes, failures, startedAt },
          };
        }, context);
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const list = await tx.doc(WatchList);
        const item = list.items[String(task.id)];
        if (item) item.state = "stopped";
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
    },
  });
}

export type WatchTask = ReturnType<typeof createWatchTask>;
