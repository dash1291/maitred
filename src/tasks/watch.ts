// Watch tasks. AirMenusWatch is the phase-1 task (kept registered so live
// tasks from older deploys keep resuming after upgrade). RecipeWatch is the
// generalized form: input carries a recipe name; the recipe's platform
// connector drives the probe. The polling loop itself is identical.

import { defineTask } from "@earendil-works/pi-durable";
import { Requests, Watches } from "../docs.ts";
import { fetchOutletConfig, dayStatus } from "../connectors/airmenus.ts";
import { loadRecipe } from "../recipes.ts";
import { platformFor } from "../connectors/index.ts";

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

// ---------------------------------------------------------------- legacy --

export interface WatchInput {
  requestId: string;
  outletId: number;
  dates: string[]; // acceptable dates, yyyy-mm-dd
  times: string[]; // acceptable times, HH:mm (empty = all)
  pollSeconds: number;
  giveUpAt: number; // epoch ms
}

export interface WatchCheckpoint {
  phase: "probe";
  probes: number;
}

export interface WatchResult {
  found: boolean;
  date?: string;
  time?: string;
  groupTitle?: string;
  reason?: string;
}

function weekdayOf(isoDate: string): (typeof WEEKDAYS)[number] {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return WEEKDAYS[d.getUTCDay()];
}

// Shared probe core: one pass over dates/times against an AirMenus-style
// config. Returns matched slot or probe notes.
// "As soon as possible": with no explicit dates, watch every bookable day
// in the platform's booking window (AirMenus: daysAhead days from today,
// filtered by the weekday rules in the outlet config).
export function upcomingDates(
  config: Awaited<ReturnType<typeof fetchOutletConfig>>,
  from = new Date(),
  daysAhead = 5,
): string[] {
  const out: string[] = [];
  for (let i = 1; i <= daysAhead; i++) {
    const d = new Date(from);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    if (!dayStatus(config, weekdayOf(iso)).open) continue;
    out.push(iso);
  }
  return out;
}

export function probeConfig(
  config: Awaited<ReturnType<typeof fetchOutletConfig>>,
  dates: string[],
  times: string[],
): { matched: { date: string; time: string; groupTitle: string } | null; notes: string[] } {
  const notes: string[] = [];
  let matched: { date: string; time: string; groupTitle: string } | null = null;
  const probeDates = dates.length > 0 ? dates : upcomingDates(config);
  if (dates.length === 0 && probeDates.length > 0) {
    notes.push(`ASAP: probing ${probeDates.join(", ")}`);
  }
  for (const date of probeDates) {
    const day = dayStatus(config, weekdayOf(date));
    if (!day.open) {
      notes.push(`${date}: closed`);
      continue;
    }
    notes.push(`${date}: OPEN`);
    for (const group of day.groups) {
      for (const slot of group.times) {
        if (times.length === 0 || times.includes(slot.time)) {
          matched = { date, time: slot.time, groupTitle: group.title };
          break;
        }
      }
      if (matched) break;
    }
    if (matched) break;
  }
  return { matched, notes };
}

export const AirMenusWatch = defineTask<WatchInput, WatchCheckpoint, WatchResult, {}>({
  name: "maitred.airmenus.watch",
  version: 1,
  initial: () => ({ phase: "probe", probes: 0 }),
  phases: {
    probe: async (task, runtime, context) => {
      const input = task.input;
      const probes = task.state.checkpoint.probes + 1;
      const probeLog: string[] = [];
      let matched: { date: string; time: string; groupTitle: string } | null = null;
      let error: string | null = null;

      try {
        const config = await fetchOutletConfig(input.outletId);
        const r = probeConfig(config, input.dates, input.times);
        matched = r.matched;
        probeLog.push(...r.notes);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        probeLog.push(`error: ${error}`);
      }

      const sleepUntil = runtime.now() + input.pollSeconds * 1000;
      await runtime.commit(async (tx) => {
        const watches = await tx.doc(Watches);
        watches[task.id] = {
          lastProbedAt: runtime.now(),
          lastStatus: probeLog.join("; ").slice(0, 400) || "ok",
          probes,
          flipsSeen: (watches[task.id]?.flipsSeen ?? 0) + (matched ? 1 : 0),
        };
        const requests = await tx.doc(Requests);
        const req = requests[input.requestId];
        if (req) {
          req.status = matched ? "confirming" : "watching";
          req.statusNote = matched
            ? `${matched.date} ${matched.time} (${matched.groupTitle})`
            : probeLog.join("; ").slice(0, 400);
          if (matched && req.bookingId === undefined) {
            req.bookingId = `${matched.date}T${matched.time}`;
          }
        }
        if (matched) {
          return {
            status: "terminal",
            outcome: { status: "completed", result: { found: true, ...matched } } as const,
          };
        }
        if (runtime.now() >= input.giveUpAt) {
          if (req) {
            req.status = "failed";
            req.statusNote = "deadline reached — no window opened";
          }
          return {
            status: "terminal",
            outcome: { status: "completed", result: { found: false, reason: "deadline" } as const },
          };
        }
        return { status: "sleeping", until: sleepUntil, checkpoint: { phase: "probe", probes } };
      }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      context,
    );
  },
});

// ------------------------------------------------------------ recipe watch --

export interface RecipeWatchInput {
  requestId: string;
  recipeName: string;
  dates: string[];
  times: string[];
  pollSeconds: number;
  giveUpAt: number;
}

export interface RecipeWatchCheckpoint {
  phase: "probe";
  probes: number;
}

export interface RecipeWatchResult extends WatchResult {
  recipeName?: string;
}

// Same durable polling loop, resolved through the recipe. Unknown/
// unsupported platform ends the task honestly rather than polling garbage.
export const RecipeWatch = defineTask<RecipeWatchInput, RecipeWatchCheckpoint, RecipeWatchResult, {}>({
  name: "maitred.recipe.watch",
  version: 1,
  initial: () => ({ phase: "probe", probes: 0 }),
  phases: {
    probe: async (task, runtime, context) => {
      const input = task.input;
      const probes = task.state.checkpoint.probes + 1;
      const probeLog: string[] = [];
      let matched: { date: string; time: string; groupTitle: string } | null = null;
      let fatal: string | null = null;

      const recipe = await loadRecipe(input.recipeName);
      if (!recipe) {
        fatal = `recipe ${input.recipeName} not found on disk`;
      } else if (recipe.restaurant.platformId !== "airmenus") {
        fatal = `platform ${recipe.restaurant.platformId} has no watch connector yet`;
      } else {
        try {
          const config = await fetchOutletConfig(Number(recipe.restaurant.ids.outletId));
          const r = probeConfig(config, input.dates, input.times);
          matched = r.matched;
          probeLog.push(...r.notes);
        } catch (e) {
          probeLog.push(`error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      const sleepUntil = runtime.now() + input.pollSeconds * 1000;
      await runtime.commit(async (tx) => {
        const watches = await tx.doc(Watches);
        watches[task.id] = {
          lastProbedAt: runtime.now(),
          lastStatus: probeLog.join("; ").slice(0, 400) || "ok",
          probes,
          flipsSeen: (watches[task.id]?.flipsSeen ?? 0) + (matched ? 1 : 0),
        };
        const requests = await tx.doc(Requests);
        const req = requests[input.requestId];
        if (req) {
          req.status = matched ? "confirming" : "watching";
          req.statusNote = matched
            ? `${matched.date} ${matched.time} (${matched.groupTitle})`
            : probeLog.join("; ").slice(0, 400);
          if (matched && req.bookingId === undefined) {
            req.bookingId = `${matched.date}T${matched.time}`;
          }
        }
        if (fatal) {
          if (req) {
            req.status = "failed";
            req.statusNote = fatal;
          }
          return {
            status: "terminal",
            outcome: { status: "completed", result: { found: false, reason: fatal } } as const,
          };
        }
        if (matched) {
          return {
            status: "terminal",
            outcome: {
              status: "completed",
              result: { found: true, recipeName: input.recipeName, ...matched },
            } as const,
          };
        }
        if (runtime.now() >= input.giveUpAt) {
          if (req) {
            req.status = "failed";
            req.statusNote = "deadline reached — no window opened";
          }
          return {
            status: "terminal",
            outcome: { status: "completed", result: { found: false, reason: "deadline" } as const },
          };
        }
        return { status: "sleeping", until: sleepUntil, checkpoint: { phase: "probe", probes } };
      }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      context,
    );
  },
});

// Pure-code day validation table shared with discovery validation lives in
// connectors; the platform registry imports the connector, and this file only
// probes with it.
