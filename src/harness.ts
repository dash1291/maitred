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
import { createModels } from "@earendil-works/pi-ai/models";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { AirMenusWatch } from "./tasks/watch.ts";
import type { WatchInput, WatchResult } from "./tasks/watch.ts";
import { Requests } from "./docs.ts";

const STATE_DIR = path.resolve(process.cwd(), "state");
mkdirSync(STATE_DIR, { recursive: true });

export interface MaitredHarness {
  harness: Harness;
  root: Conversation;
}

export async function bootstrap(): Promise<MaitredHarness> {
  const context = BACKGROUND_CONTEXT;

  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "maitred",
      tasks: [AirMenusWatch],
    }),
  );

  // The watch tier needs no model at all. Phase 2 (discovery) replaces this
  // empty catalog with a real provider (Anthropic, reads ANTHROPIC_API_KEY):
  // watch tasks never call generate, so an empty Models passes type+runtime.
  const models = createModels();

  const storage = await openNodeSqliteStorage(
    path.join(STATE_DIR, "maitred.sqlite"),
  );

  const harness = await HarnessImpl.open(storage, { models, registry }, context);
  const root = await harness.root(context);
  harness.resume();

  return { harness, root };
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
