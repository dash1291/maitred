import type { JsonValue } from "@earendil-works/chord/json";
import { defineTool } from "@earendil-works/pi-durable";
import { arr, num, obj, oneOf, opt, str, unknown } from "@earendil-works/pi-schema";
import type { Step } from "../browser.ts";
import {
  listNewWatch,
  MIN_BROWSER_INTERVAL_SECONDS,
  vetWatch,
  WATCH_TASK_OPTIONS,
  WatchList,
  type WatchDeps,
  type WatchProof,
  type WatchSpec,
  type WatchTask,
} from "../watch.ts";

export type WatchToolDeps = WatchDeps & {
  task: WatchTask;
  stop(taskId: string): Promise<void>;
};

const DESCRIPTION = `Keep checking a page until something becomes available, without spending model calls while waiting.

A watch does what a person would do, over and over: it opens the page in a browser, follows your steps, and reads
what the page then shows.

start: needs label, steps, rule, params, proof, timezone, intervalSeconds, alert; until is optional.
  steps: the path to the page that answers the question, as a list of
      { "action": "open", "url": ... } | { "action": "click", "target": ... } | { "action": "select", "target": ..., "value": ... }
    Walk the path yourself in the browser first, then give exactly the steps that worked. Name every target by the
    text a person sees, never by a control number. Write {name} to insert a value from params, for example
    https://venue.example/reserve?date={date}&party_size={pax}. Prefer a URL that carries the date and party size.
  rule: the body of an async JavaScript function that reads the page the steps ended on:
    - input.page is { url, title, text, controls }, where each control is { kind, name, value, options, disabled }.
    - input.params is the "params" you pass; input.today is today (yyyy-mm-dd) in "timezone".
    - Return an array of matches, each a small object describing one thing the person can take, such as
      { date, time }. Return [] only when the page itself shows nothing available.
    - If the page is not the one you expected (the list of times is missing, a different heading), throw.
      An empty result must never hide a path that went wrong.
  proof: params for which the page shows something available right now, such as another date or party size.
    The steps and rule are run with them and must return a match. A watch that has never found anything real is
    not trusted. Only if nothing anywhere is available to prove it with, leave proof out and set "unproven" to
    the reason; the person is then told the watch may be blind.
  intervalSeconds: at least 60. Use 300 unless the person asks for something else.
  The steps and rule are also run once with "params". If that fails, nothing starts and you get the error.
  If it already matches, nothing starts and you get the matches.
  then: your note to yourself for the moment it matches. If the person wants something done, not only to be told,
    write it here in full; the conversation may have moved on by then.
  When a later probe matches, the watch ends and you receive a message with the matches, your alert text and your note.
list: every watch with its state and last result.
stop: needs id.`;

export function createWatchTool(deps: WatchToolDeps) {
  return defineTool({
    name: "watch",
    description: DESCRIPTION,
    callers: ["model"],
    parameters: obj({
      action: oneOf(["start", "list", "stop"]),
      id: opt(str({ description: "Watch id. For stop." })),
      label: opt(str({ description: "What is being watched, for people." })),
      steps: opt(
        arr(
          obj({
            action: oneOf(["open", "click", "select"]),
            url: opt(str()),
            target: opt(str()),
            value: opt(str()),
          }),
          { description: "The path to the page, as described above." },
        ),
      ),
      rule: opt(str({ description: "Script body, as described above." })),
      params: opt(unknown({ description: "JSON object passed to the rule as input.params. An object, not a string." })),
      proof: opt(unknown({ description: "JSON object: params for which the rule matches right now." })),
      unproven: opt(str({ description: "Only when no proof exists: why not." })),
      then: opt(
        str({
          description:
            "A note to yourself: exactly what to do the moment this matches, with everything you will need to do it " +
            "(for example which times to book, for how many, under whose details). It is handed back to you with the matches.",
        }),
      ),
      timezone: opt(str({ description: "IANA timezone of the venue, for example Asia/Kolkata." })),
      intervalSeconds: opt(num({ description: `Seconds between probes; at least ${MIN_BROWSER_INTERVAL_SECONDS}.` })),
      until: opt(str({ description: "ISO 8601 time with offset at which to give up. Omit to watch until stopped." })),
      alert: opt(str({ description: "What to tell the person on a match, including the page they should open." })),
    }),
    // params and proof have no fixed shape, and models then tend to send them as JSON strings.
    prepareArguments(args) {
      const given = { ...(args as Record<string, unknown>) };
      for (const key of ["params", "proof"]) {
        const value = given[key];
        if (typeof value !== "string") continue;
        try {
          const parsed: unknown = JSON.parse(value);
          if (parsed !== null && typeof parsed === "object") given[key] = parsed;
        } catch {}
      }
      return given as never;
    },
    execute: async (args, api, context) => {
      const text = (value: string, isError = false) => ({ output: [{ type: "text" as const, text: value }], isError });

      if (args.action === "list") {
        const list = await api.snapshot(WatchList, context);
        const items = Object.entries(list?.items ?? {});
        if (items.length === 0) return text("No watches.");
        return text(
          items
            .map(([id, w]) =>
              [
                `${id}: ${w.label} [${w.state}]${w.unproven ? ` UNPROVEN: ${w.unproven}` : ""}`,
                `  every ${w.intervalSeconds}s, ${w.probes} probes, last ${new Date(w.lastProbedAt).toISOString()}: ${w.note}`,
                ...(w.matches ? [`  matches: ${JSON.stringify(w.matches)}`] : []),
              ].join("\n"),
            )
            .join("\n"),
        );
      }

      if (args.action === "stop") {
        if (!args.id) return text("id is required", true);
        const list = await api.snapshot(WatchList, context);
        const item = list?.items[args.id];
        if (!item) return text(`no watch with id ${args.id}`, true);
        if (item.state !== "watching") return text(`watch ${args.id} already ended: ${item.state}`);
        await deps.stop(args.id);
        return text(`stopped watch ${args.id}`);
      }

      const now = api.now();
      const until = args.until === undefined ? undefined : Date.parse(args.until);
      if (until !== undefined && Number.isNaN(until)) return text("until is not an ISO 8601 time", true);
      const spec: WatchSpec = {
        label: args.label ?? "",
        rule: args.rule ?? "",
        steps: (args.steps ?? []).map((step): Step =>
          step.action === "open"
            ? { action: "open", url: step.url ?? "" }
            : step.action === "click"
              ? { action: "click", target: step.target ?? "" }
              : { action: "select", target: step.target ?? "", value: step.value ?? "" },
        ),
        hosts: [],
        params: (args.params ?? null) as JsonValue,
        timezone: args.timezone ?? "",
        intervalSeconds: args.intervalSeconds ?? Number.NaN,
        alert: args.alert ?? "",
        ...(until === undefined ? {} : { until }),
        ...(args.unproven === undefined ? {} : { unproven: args.unproven }),
        ...(args.then === undefined ? {} : { then: args.then }),
      };
      const refused = await vetWatch(spec, args.proof as WatchProof, now, deps);
      if (refused) return text(refused.refusal, refused.isError);

      const id = await api.createTask(deps.task, spec, WATCH_TASK_OPTIONS, context);
      await api.commit((tx) => listNewWatch(tx, String(id), spec, now), context);
      return text(
        spec.unproven
          ? `Watch ${id} started UNPROVEN: its rule has never been seen to match. Tell the person it may be blind, and why.`
          : `Watch ${id} started. Its rule matched the proof params and finds nothing yet for the real ones.`,
      );
    },
  });
}
