import { defineTask } from "@earendil-works/pi-durable";
import { Requests, Watches } from "../docs.ts";
import { fetchOutletConfig, dayStatus } from "../connectors/airmenus.ts";

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

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

// Pure-code durable polling loop, zero LLM involvement:
//   probe -> commit sleeping(pollSeconds) -> probe -> ...
// The sleep deadline is durable state; a crash/restart resumes the loop
// through harness.resume() when the timer next comes due.
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
        for (const date of input.dates) {
          const day = dayStatus(config, weekdayOf(date));
          if (!day.open) {
            probeLog.push(`${date}: closed`);
            continue;
          }
          probeLog.push(`${date}: OPEN`);
          for (const group of day.groups) {
            for (const slot of group.times) {
              if (input.times.length === 0 || input.times.includes(slot.time)) {
                matched = { date, time: slot.time, groupTitle: group.title };
                break;
              }
            }
            if (matched) break;
          }
          if (matched) break;
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        probeLog.push(`error: ${error}`);
      }

      // Bookkeeping + optional terminal/sleep state, all in one commit.
      const sleepUntil = runtime.now() + input.pollSeconds * 1000;
      await runtime.commit(
        async (tx) => {
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
              outcome: {
                status: "completed",
                result: { found: true, ...matched },
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
              outcome: {
                status: "completed",
                result: { found: false, reason: "deadline" } as const,
              } as const,
            };
          }
          return {
            status: "sleeping",
            until: sleepUntil,
            checkpoint: { phase: "probe", probes },
          };
        },
        context,
      );
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(
      () => ({
        status: "terminal",
        outcome: { status: "aborted" },
      }),
      context,
    );
  },
});
