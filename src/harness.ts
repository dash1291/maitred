import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  type Conversation,
  type Harness,
  type TaskId,
  Harness as HarnessImpl,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { doublewordProvider } from "./doubleword.ts";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { AirMenusWatch, RecipeWatch } from "./tasks/watch.ts";
import type { WatchInput, WatchResult } from "./tasks/watch.ts";
import { Discover } from "./tasks/discover.ts";
import { Requests } from "./docs.ts";

const STATE_DIR = path.resolve(process.cwd(), "state");
mkdirSync(STATE_DIR, { recursive: true });

export interface MaitredHarness {
  harness: Harness;
  root: Conversation;
  /** Present when a model provider is configured (discovery + LLM parsing). */
  models?: Models;
  modelProvider?: string;
}

export async function bootstrap(): Promise<MaitredHarness> {
  const context = BACKGROUND_CONTEXT;

  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "maitred",
      tasks: [AirMenusWatch, RecipeWatch, Discover],
    }),
  );

  // Watch tier: pure code, no model needed. Discovery tier (phase 2) needs a
  // chat model; provider is env-chosen so the server's .env decides:
  //   MAITRED_MODEL_PROVIDER=anthropic  (default; ANTHROPIC_API_KEY)
  //   MAITRED_MODEL_PROVIDER=doubleword (DOUBLEWORD_API_KEY, personal creds)
  // Without either key the daemon still boots and watches fine; discovery
  // requests fail at run time with a clear auth error.
  const models = createModels();
  const providerChoice = process.env.MAITRED_MODEL_PROVIDER ?? "anthropic";
  if (providerChoice === "doubleword" && process.env.DOUBLEWORD_API_KEY) {
    models.setProvider(doublewordProvider());
  } else if (process.env.ANTHROPIC_API_KEY) {
    models.setProvider(anthropicProvider());
  }

  const storage = await openNodeSqliteStorage(
    path.join(STATE_DIR, "maitred.sqlite"),
  );

  const harness = await HarnessImpl.open(storage, { models, registry }, context);
  const root = await harness.root(context);
  harness.resume();

  const hasProvider =
    (providerChoice === "doubleword" && Boolean(process.env.DOUBLEWORD_API_KEY)) ||
    (providerChoice !== "doubleword" && Boolean(process.env.ANTHROPIC_API_KEY));
  return {
    harness,
    root,
    models: hasProvider ? models : undefined,
    modelProvider: hasProvider ? providerChoice : undefined,
  };
}

// Spawn a durable watch. Used by the CLI (phase 1) and the Telegram bot
// (phase 1.5). The conversation owns the task, so conversation abort
// cancels the watch subtree.
export async function startWatch(
  m: MaitredHarness,
  input: WatchInput & { pax?: number },
): Promise<TaskId<WatchResult>> {
  const context = BACKGROUND_CONTEXT;
  const watchId = await m.root.commit(
    async (tx) => {
      const requests = await tx.doc(Requests);
      requests[input.requestId] = {
        restaurant: `airmenus-outlet-${input.outletId}`,
        pax: input.pax ?? 0,
        dates: input.dates,
        times: input.times,
        status: "watching",
        createdAt: Date.now(),
      };
      return tx.createTask(
        AirMenusWatch,
        input,
        { ownership: { kind: "conversation" } },
      );
    },
    context,
  );
  // tx.createTask() resolves to the TaskId only after the commit returns
  // (inside the tx it is a Promise). Stamp it for the UI via a tiny second
  // commit — the doc is the request->task map the web/telegram tiers use.
  await m.root.commit(async (tx) => {
    const requests = await tx.doc(Requests);
    if (requests[input.requestId]) {
      requests[input.requestId].taskId = String(watchId);
    }
  }, context);
  return watchId;
}

// Terminal result of a watch, for notification.
export async function watchOutcome(
  m: MaitredHarness,
  taskId: TaskId<WatchResult>,
): Promise<WatchResult> {
  const context = BACKGROUND_CONTEXT;
  const settled = await m.harness.waitForTask(taskId, context);
  const outcome = settled.state.outcome;
  return outcome.status === "completed"
    ? (outcome.result as WatchResult)
    : { found: false, reason: `outcome ${outcome.status}` };
}
