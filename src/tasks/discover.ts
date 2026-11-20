// DiscoverTask — the durable discovery state machine (spec §3).
//
// Input: a request (restaurant, city, dates/times/pax) with no existing
// recipe. The value produced is a Recipe (typed data), validated read-only,
// human-gated, then published; publish also spawns the watch as a child task
// and the discovery settles when the watch does.
//
// Division of labor with the dispatcher (src/request.ts):
//   dispatcher creates this task, then the recon conversation (task-owned,
//   coding tools + instructions), then submits one recon prompt with
//   notify={this task, settledKey}. This task only ever waits for signals:
//
//   recon    sleep on SubmissionSettled(settledKey) until reconDeadline
//   inspect  woke: pull the conversation's last assistant entry, extract
//            the fenced recipe JSON, schema + platform-requirements check
//   validate read-only replay via the platform connector (pure code)
//   gate     sleep on maitred.confirm recipe:<slug>:approve / :reject keys
//            (which key woke decides; no value parsing needed) with 24h expiry
//   publish  recipe -> recipes/<slug>.json + Recipes doc + Request stamp,
//            then create the RecipeWatch child and wait on it
//   awaitWatch watch terminal: settle this task
//
// Every phase commits its own checkpoint, so a crash resumes mid-flight
// without re-running completed phases (and without re-spending their tokens).

import { defineTask, SubmissionSettled } from "@earendil-works/pi-durable";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Requests, Recipes } from "../docs.ts";
import {
  settledKeyFor,
  RECON_PROMPT,
} from "../agents/recon.ts";
import { ConfirmApproveKey, ConfirmRejectKey } from "../signals.ts";
import {
  parseRecipe,
  checkPlatformRequirements,
  type Recipe,
} from "../recipe-schema.ts";
import { platformFor } from "../connectors/index.ts";
import { RecipeWatch } from "./watch.ts";
import { RECIPE_DIR_PATH } from "../recipes.ts";

export interface DiscoverInput {
  requestId: string;
  restaurantName: string;
  city: string;
  dates: string[]; // acceptable dates, yyyy-mm-dd
  times: string[]; // acceptable times, HH:mm (empty = all)
  pax: number;
  pollSeconds: number;
  giveUpAt: number; // watch give-up deadline, epoch ms
  reconDeadlineMs: number; // recon budget, epoch ms
}

export type DiscoverCheckpoint =
  | { phase: "recon" }
  | { phase: "inspect" }
  | { phase: "validate"; recipe: Recipe }
  | { phase: "gate"; recipe: Recipe }
  | { phase: "publish"; recipe: Recipe; watchTaskId?: string }
  | { phase: "awaitWatch"; recipe: Recipe; watchTaskId?: string };

export type DiscoverResult =
  | { status: "recipe-published"; recipe: Recipe; watch: string }
  | { status: "failed"; reason: string };

// Phases dispatch via the committed checkpoint, watch/document.ts style.
export const Discover = defineTask<DiscoverInput, DiscoverCheckpoint, DiscoverResult, {}>({
  name: "maitred.discover",
  version: 1,
  initial: () => ({ phase: "recon" }) as DiscoverCheckpoint,
  phases: {
    // Wait for the recon conversation (created+submitted by the dispatcher)
    // to settle, or the budget to lapse.
    recon: async (task, runtime, context) => {
      const key = settledKeyFor(task.input.requestId);
      await runtime.commit(
        () => ({
          status: "sleeping" as const,
          until: task.input.reconDeadlineMs,
          signals: [SubmissionSettled.key(key)],
          checkpoint: { phase: "inspect" },
        }),
        context,
      );
    },

    inspect: async (task, runtime, context) => {
      const input = task.input;
      const wake = task.state.wake;

      await runtime.commit(async (tx) => {
        const requests = await tx.doc(Requests);
        const req = requests[input.requestId];
        const convId = req?.reconConversationId;
        let answer: string | null = null;
        if (wake?.reason === "signal" && wake.signal === SubmissionSettled.name && convId) {
          const page = await tx.scanEntries(
            { conversationId: convId as never, order: "descending" },
            8,
          );
          for (const e of page.items) {
            const model = e.model ?? [];
            for (let i = model.length - 1; i >= 0; i--) {
              const m = model[i] as { role?: string; content?: unknown };
              if (m.role !== "assistant") continue;
              const blocks = Array.isArray(m.content) ? m.content : [];
              const text = blocks
                .map((b) => (typeof b === "object" && b && (b as { type?: string }).type === "text"
                  ? String((b as { text?: string }).text ?? "")
                  : ""))
                .join("");
              if (text.trim()) {
                answer = text;
                break;
              }
            }
            if (answer) break;
          }
        }
        if (!answer) {
          const reason =
            wake?.reason === "time" || wake?.reason === "expired"
              ? "recon budget reached — no recipe"
              : "recon ended without an answer";
          if (req) {
            req.status = "failed";
            req.statusNote = reason;
          }
          return {
            status: "terminal" as const,
            outcome: { status: "completed", result: { status: "failed", reason } },
          };
        }
        // Extract the last fenced json block (the recipe).
        const blocks = [...answer.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
        const jsonText = blocks.length > 0 ? blocks[blocks.length - 1][1] : null;
        if (!jsonText) {
          if (req) {
            req.status = "failed";
            req.statusNote = "recon produced no recipe JSON block";
          }
          return {
            status: "terminal" as const,
            outcome: { status: "completed", result: { status: "failed", reason: "no-json-block" } },
          };
        }
        try {
          const recipe = parseRecipe(jsonText);
          const issues = checkPlatformRequirements(recipe);
          if (issues.length > 0) throw new Error(issues.join("; "));
          if (recipe.restaurant.platformId === "generic") {
            throw new Error("generic-http connector not built yet; known platforms only");
          }
          if (req) {
            req.status = "discovering";
            req.statusNote = `recipe drafted: ${recipe.name} (${recipe.restaurant.platformId}) — validating`;
            req.recipeName = recipe.name;
          }
          return {
            status: "running" as const,
            checkpoint: { phase: "validate", recipe },
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (req) {
            req.status = "failed";
            req.statusNote = `recipe invalid: ${msg.slice(0, 300)}`;
          }
          return {
            status: "terminal" as const,
            outcome: { status: "completed", result: { status: "failed", reason: `recipe-invalid: ${msg}` } },
          };
        }
      }, context);
    },

    validate: async (task, runtime, context) => {
      const input = task.input;
      const recipe = task.state.checkpoint.recipe!;
      const platform = platformFor(recipe.restaurant.platformId);
      const result = platform
        ? await platform.validate(recipe)
        : { ok: false as const, reason: `no platform connector for ${recipe.restaurant.platformId}` };

      await runtime.commit(async (tx) => {
        const requests = await tx.doc(Requests);
        const req = requests[input.requestId];
        if (!result.ok) {
          if (req) {
            req.status = "failed";
            req.statusNote = `validation failed: ${result.reason}`;
          }
          return {
            status: "terminal" as const,
            outcome: { status: "completed", result: { status: "failed", reason: `validate: ${result.reason}` } },
          };
        }
        const validated = { ...recipe, validation: result.value };
        if (req) {
          req.status = "discovering";
          req.statusNote = `validated (${result.value.slotsEnumerated} slots seen) — awaiting confirm to publish`;
        }
        return {
          status: "sleeping" as const,
          until: runtime.now() + 24 * 60 * 60 * 1000,
          signals: [ConfirmApproveKey(validated.name), ConfirmRejectKey(validated.name)],
          checkpoint: { phase: "gate", recipe: validated },
        };
      }, context);
    },

    gate: async (task, runtime, context) => {
      const input = task.input;
      const recipe = task.state.checkpoint.recipe!;
      const wake = task.state.wake;
      const approved =
        wake?.reason === "signal" && wake.key === ConfirmApproveKey(recipe.name).key;
      await runtime.commit(async (tx) => {
        const requests = await tx.doc(Requests);
        const req = requests[input.requestId];
        if (!approved) {
          if (req) {
            req.status = "failed";
            req.statusNote = wake?.reason === "signal" ? "recipe rejected" : "confirm timeout — recipe discarded";
          }
          return {
            status: "terminal" as const,
            outcome: {
              status: "completed",
              result: { status: "failed", reason: wake?.reason === "signal" ? "rejected" : "confirm-timeout" },
            },
          };
        }
        return { status: "running" as const, checkpoint: { phase: "publish", recipe } };
      }, context);
    },

    // Idempotent on re-run: the file write and doc stamps are overwrites;
    // the child is guarded by checkpoint.watchTaskId (same commit).
    publish: async (task, runtime, context) => {
      const input = task.input;
      const recipe = task.state.checkpoint.recipe!;
      await mkdir(RECIPE_DIR_PATH, { recursive: true });
      await writeFile(
        path.join(RECIPE_DIR_PATH, `${recipe.name}.json`),
        JSON.stringify(recipe, null, 2) + "\n",
      );

      await runtime.commit(async (tx) => {
        const recipesDoc = await tx.doc(Recipes);
        recipesDoc[recipe.name] = {
          platform: recipe.restaurant.platformId,
          recipeFile: `${recipe.name}.json`,
          knownSince: runtime.now(),
        };
        const requests = await tx.doc(Requests);
        const req = requests[input.requestId];
        if (req) {
          req.recipeName = recipe.name;
          req.status = "watching";
          req.statusNote = `recipe published — watching`;
        }
        if (task.state.checkpoint.watchTaskId) {
          return {
            status: "waiting" as const,
            on: [task.state.checkpoint.watchTaskId as never],
            policy: "any" as const,
            checkpoint: { phase: "awaitWatch", recipe, watchTaskId: task.state.checkpoint.watchTaskId },
          };
        }
        const watchId = await tx.createTask(
          RecipeWatch,
          {
            requestId: input.requestId,
            recipeName: recipe.name,
            dates: input.dates,
            times: input.times,
            pollSeconds: input.pollSeconds,
            giveUpAt: input.giveUpAt,
          },
          { ownership: { kind: "task" } as never },
        );
        return {
          status: "waiting" as const,
          on: [watchId],
          policy: "any" as const,
          checkpoint: { phase: "awaitWatch", recipe, watchTaskId: String(watchId) },
        };
      }, context);
    },

    awaitWatch: async (task, runtime, context) => {
      void context;
      const recipe = task.state.checkpoint.recipe!;
      await runtime.commit(
        () => ({
          status: "terminal" as const,
          outcome: {
            status: "completed",
            result: {
              status: "recipe-published",
              recipe,
              watch: task.state.checkpoint.watchTaskId ?? "",
            },
          },
        }),
        context,
      );
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      context,
    );
  },
});

export { RECON_PROMPT };
