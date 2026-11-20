// Request dispatcher: a natural-language message ("get me a table at Loya
// Saturday 8pm, 4 people") becomes exactly one durable request, routed:
//
//   known recipe  -> RecipeWatch task ("maitred.recipe.watch")
//   unknown place -> Discover task ("maitred.discover"), which on success
//                    publishes the recipe and spawns the watch itself
//
// Parsing is LLM-first (parse.ts): one cheap structured-output call per
// message. The regex parser below is the no-model fallback for watch-only
// deployments and a safety net if the model call fails.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Requests } from "./docs.ts";
import { findRecipe, slugify } from "./recipes.ts";
import { RecipeWatch } from "./tasks/watch.ts";
import { Discover } from "./tasks/discover.ts";
import type { DiscoverInput } from "./tasks/discover.ts";
import { reconAgentChange, scratchDirFor, settledKeyFor, RECON_PROMPT } from "./agents/recon.ts";
import { mkdirSync } from "node:fs";
import type { MaitredHarness } from "./harness.ts";
import { parseRequestLlm, type ParsedRequest } from "./parse.ts";
export { type ParsedRequest };

const DEFAULT_CITY = "Bangalore";
// (The LLM parser in parse.ts is the only parser. There is no regex
// fallback: a message-driven deployment always has a model configured, and
// structured inputs (web form, API) never pass through free text.

export interface DispatchResult {
  requestId: string;
  route: "recipe" | "discovery" | "rejected";
  recipeName?: string;
  taskId?: string;
  parse: "llm" | "none";
  error?: string;
}

// LLM-only parsing (parse.ts). No fallback: a free-text message with no
// model configured or an unparseable reply is rejected with an error —
// structured inputs (web form) never pass through here.
export async function parseRequest(
  m: MaitredHarness,
  message: string,
): Promise<ParsedRequest | null> {
  if (!m.models || !m.modelProvider) return null;
  return parseRequestLlm(m.models, m.modelProvider, message);
}


// The recon agent needs a capable chat model (it runs tools and reads JS).
// Per-provider defaults, overridable; falls back to the provider's first
// model if a hardcoded id has gone stale.
export function reconModelFor(m: MaitredHarness): { provider: string; modelId: string } {
  const provider = m.modelProvider!;
  const wanted =
    process.env.MAITRED_RECON_MODEL ??
    (provider === "doubleword"
      ? "zai-org/GLM-5.3"
      : "claude-sonnet-4-5");
  const models = m.models!;
  const exact = models.getModel(provider, wanted);
  if (exact) return { provider, modelId: wanted };
  const any = models.getModels(provider)[0];
  if (!any) throw new Error(`provider ${provider} has no models`);
  return { provider, modelId: any.id };
}

// Route one message.
// Route one message. Exactly one Request doc entry is created; it gets a
// taskId (watch or discover) and, for discovery, a reconConversationId.
export async function startFromMessage(
  m: MaitredHarness,
  message: string,
): Promise<DispatchResult> {
  const context = BACKGROUND_CONTEXT;
  const parsed = await parseRequest(m, message);
  if (!parsed) {
    return {
      requestId: `req-${Date.now()}`,
      route: "rejected",
      parse: "none",
      error: m.models
        ? "could not parse the message — try rephrasing"
        : "no model configured — set MAITRED_MODEL_PROVIDER and an API key to accept free-text messages",
    };
  }
  const via = "llm" as const;
  const requestId = `req-${Date.now()}`;

  const recipe = await findRecipe(parsed.restaurantName);

  if (recipe) {
    // Known recipe: straight to the watch.
    const input = {
      requestId,
      recipeName: recipe.name,
      dates: parsed.dates,
      times: parsed.times,
      pollSeconds: 4,
      giveUpAt: Date.now() + 6 * 60 * 60 * 1000,
    };
    const watchId = await m.root.commit(async (tx) => {
      const requests = await tx.doc(Requests);
      requests[requestId] = {
        restaurant: recipe.restaurant.displayName,
        pax: parsed.pax,
        dates: parsed.dates,
        times: parsed.times,
        status: "watching",
        statusNote: `watching via ${recipe.name}`,
        recipeName: recipe.name,
        createdAt: Date.now(),
      };
      return tx.createTask(RecipeWatch, input, { ownership: { kind: "conversation" } });
    }, context);
    await stampTaskId(m, requestId, watchId);
    return { requestId, route: "recipe", recipeName: recipe.name, taskId: String(watchId), parse: via };
  }

  // Unknown restaurant: discovery.
  const discovery: DiscoverInput = {
    requestId,
    restaurantName: parsed.restaurantName,
    city: parsed.city,
    dates: parsed.dates,
    times: parsed.times,
    pax: parsed.pax,
    pollSeconds: 4,
    giveUpAt: Date.now() + 6 * 60 * 60 * 1000,
    reconDeadlineMs: Date.now() + 30 * 60 * 1000,
  };
  const discoverId = await m.root.commit(async (tx) => {
    const requests = await tx.doc(Requests);
    requests[requestId] = {
      restaurant: parsed.restaurantName,
      pax: parsed.pax,
      dates: parsed.dates,
      times: parsed.times,
      status: "accepted",
      statusNote: "no recipe yet — starting discovery",
      createdAt: Date.now(),
    };
    return tx.createTask(Discover, discovery, { ownership: { kind: "conversation" } });
  }, context);
  await stampTaskId(m, requestId, discoverId);

  // Recon conversation: task-owned, coding tools, scratch cwd. Created and
  // submitted from host code (the only layer that can apply the agent
  // config at creation); the task waits on the settle signal.
  const scratch = scratchDirFor(requestId);
  mkdirSync(scratch, { recursive: true });
  const conv = await m.harness.createConversation(
    {
      ownership: { kind: "task", taskId: discoverId as never },
      agent: reconAgentChange(scratch, reconModelFor(m)),
    },
    context,
  );
  await m.root.commit(async (tx) => {
    const requests = await tx.doc(Requests);
    if (requests[requestId]) {
      requests[requestId].reconConversationId = conv.id as never;
      requests[requestId].status = "discovering";
      requests[requestId].statusNote = "recon agent running";
    }
  }, context);
  await conv.submit(
    {
      type: "input",
      content: RECON_PROMPT(parsed),
      notify: { taskId: discoverId as never, key: settledKeyFor(requestId) },
    } as never,
    context,
  );
  return { requestId, route: "discovery", taskId: String(discoverId), parse: via };
}

async function stampTaskId(m: MaitredHarness, requestId: string, taskId: unknown) {
  const context = BACKGROUND_CONTEXT;
  await m.root.commit(async (tx) => {
    const requests = await tx.doc(Requests);
    if (requests[requestId]) {
      requests[requestId].taskId = String(taskId);
    }
  }, context);
}

// Deliver an approve/reject on a recipe awaiting its gate. Wakes the
// discovery task from its gate sleep; `which key woke it` carries the answer.
export async function confirmRecipe(
  m: MaitredHarness,
  requestId: string,
  approve: boolean,
): Promise<"delivered" | "duplicate" | "invalid" | "closed" | "not_found" | "no-request" | "no-recipe" | "no-task"> {
  const context = BACKGROUND_CONTEXT;
  const { Confirm, ConfirmApproveKey, ConfirmRejectKey } = await import("./signals.ts");

  let info: { recipeName?: string; taskId?: string } = {};
  await m.root.commit(async (tx) => {
    const docs = await tx.doc(Requests);
    if (!(requestId in docs)) return undefined as never;
    const r = docs[requestId];
    info = { recipeName: r.recipeName, taskId: r.taskId };
    return undefined as never;
  }, context);
  if (!("recipeName" in info)) return "no-request";
  if (!info.recipeName || !info.taskId) return info.taskId ? "no-recipe" : "no-task";

  const key = approve ? ConfirmApproveKey(info.recipeName).key : ConfirmRejectKey(info.recipeName).key;
  const result = await m.root.commit(async (tx) =>
    tx.signal(info.taskId as never, Confirm, key, { approved: approve ? "yes" : "no" }),
  context);
  return result;
}

export { type DiscoverInput };
