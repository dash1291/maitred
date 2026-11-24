import { mkdirSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  GenerationTask,
  Harness as HarnessImpl,
  hook,
  type Conversation,
  type Harness,
  type ModelRef,
  type SignalResult,
  type Storage,
  type Submission,
  type TaskId,
  type TypedEntry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Approval, DECISION, TypingAllowances } from "./approval.ts";
import { createBrowsers } from "./browser.ts";
import { instructions } from "./assistant.ts";
import { BUILTIN_RECIPES_DIR, localStamp, STATE_DIR, TIMEZONE } from "./config.ts";
import { doublewordProvider } from "./doubleword.ts";
import { listedHosts, publicHost, type HostPolicy } from "./http.ts";
import { createTelegram, type TelegramOptions } from "./telegram.ts";
import { createBrowserTool } from "./tools/browser.ts";
import { createRecipesSection, createRecipesTool, createRecipeStore, type RecipeStore } from "./tools/recipes.ts";
import { createWatchTool } from "./tools/watch.ts";
import { createWatchTask, listNewWatch, vetWatch, WATCH_TASK_OPTIONS, type WatchProof, type WatchSpec } from "./watch.ts";

export type BootOptions = {
  storage?: Storage;
  /** A `Models` with its provider set, and the model the assistant runs on. Default: from the environment. */
  models?: Models;
  model?: ModelRef;
  recipeDirs?: { writable: string; builtin: string };
  /** Which hosts may be reached at all. Default: public hosts only. */
  reachable?: HostPolicy;
  timezone?: string;
  /** Default: from MAITRED_TELEGRAM_TOKEN and MAITRED_TELEGRAM_CHAT. null: no Telegram. */
  telegram?: TelegramOptions | null;
};

export type Answer = { ok: true; text: string } | { ok: false; reason: string };

export type Maitred = {
  harness: Harness;
  root: Conversation;
  model: ModelRef | undefined;
  recipes: RecipeStore;
  /** Hand the assistant a message from the person. */
  say(text: string, requestId?: string): Promise<Submission>;
  answerOf(submission: Submission): Promise<Answer>;
  /** Start a watch without the model; the same checks as the watch tool. Returns its id, or why it did not start. */
  startWatch(spec: WatchSpec, proof?: WatchProof): Promise<{ id: string } | { refusal: string }>;
  stopWatch(id: string): Promise<void>;
  /** Answer a pending approval. */
  decide(taskId: string, allow: boolean): Promise<SignalResult>;
  /** Withdraw the details pre-approved for typing on a site; they are asked for again. */
  forgetTyping(site: string): Promise<void>;
  close(): Promise<void>;
};

function modelsFromEnv(): { models: Models; model: ModelRef | undefined } {
  const models = createModels();
  const provider = process.env.MAITRED_MODEL_PROVIDER ?? "anthropic";
  if (provider === "doubleword" && process.env.DOUBLEWORD_API_KEY) models.setProvider(doublewordProvider());
  else if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) models.setProvider(anthropicProvider());
  else return { models, model: undefined };

  const wanted = process.env.MAITRED_MODEL ?? (provider === "doubleword" ? "zai-org/GLM-5.3" : "claude-opus-5-5");
  const modelId = models.getModel(provider, wanted)?.id ?? models.getModels(provider)[0]?.id;
  return { models, model: modelId ? { provider, modelId } : undefined };
}

function telegramFromEnv(): TelegramOptions | null {
  const token = process.env.MAITRED_TELEGRAM_TOKEN;
  return token ? { token, chatId: process.env.MAITRED_TELEGRAM_CHAT } : null;
}

function textOf(entry: TypedEntry<never> | undefined): string {
  const message = entry?.model?.[0];
  const content = message?.role === "assistant" ? message.content : [];
  return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

export async function bootstrap(options: BootOptions = {}): Promise<Maitred> {
  const context = BACKGROUND_CONTEXT;
  const reachable = options.reachable ?? publicHost;
  const timezone = options.timezone ?? TIMEZONE;
  const { models, model } = options.models
    ? { models: options.models, model: options.model }
    : modelsFromEnv();

  const recipes = createRecipeStore(
    options.recipeDirs ?? { writable: path.join(STATE_DIR, "recipes"), builtin: BUILTIN_RECIPES_DIR },
  );
  const telegramOptions = options.telegram === undefined ? telegramFromEnv() : options.telegram;
  const telegram = telegramOptions ? createTelegram(telegramOptions) : undefined;
  const push = (text: string, approvalId?: string) => telegram?.send(text, approvalId) ?? Promise.resolve();
  const announce = (id: string, ask: { question: string; detail: string }) => push(`${ask.question}\n\n${ask.detail}`, id);

  const browsers = createBrowsers({ reachable, timezone });
  const watchDeps = {
    allowFor: (hosts: readonly string[]) => listedHosts(hosts, reachable),
    alert: push,
    walk: browsers.walk,
  };
  const Watch = createWatchTask(watchDeps);

  let harness: Harness | undefined;
  const stopWatch = async (id: string) => {
    const taskId = Number(id) as TaskId;
    if ((await harness!.abortTask(taskId, context)) === "marked") await harness!.waitForTask(taskId, context);
  };

  const browserTool = createBrowserTool({ browsers, announce });
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "maitred",
      tools: [
        createRecipesTool(recipes),
        createWatchTool({ ...watchDeps, task: Watch, stop: stopWatch }),
        browserTool,
      ],
      sections: [createRecipesSection(recipes)],
      tasks: [Watch],
      hooks: [
        hook(GenerationTask, {
          afterRun: async (run, api, hookContext) => {
            await push(textOf(await api.entry(AssistantEntry, run.answer, hookContext)));
            return undefined;
          },
        }),
      ],
    }),
  );

  let storage = options.storage;
  if (!storage) {
    mkdirSync(STATE_DIR, { recursive: true });
    storage = await openNodeSqliteStorage(path.join(STATE_DIR, "maitred.sqlite"));
  }
  harness = await HarnessImpl.open(storage, { models, registry }, context);
  const opened = harness;
  const root = await opened.root(context);
  const pushes = telegramOptions?.chatId !== undefined;
  // The harness leaves thinking off unless told otherwise, and this assistant's work is all judgement.
  await root.configure(
    { model: model ?? null, thinkingLevel: "high", instructions: instructions({ pushes }), maxTurns: 80 },
    context,
  );
  opened.resume();

  const say = (text: string, requestId?: string) =>
    root.submit(
      {
        type: "input",
        content: `[${localStamp(Date.now(), timezone)}]\n${text}`,
        entry: { kind: "maitred.user", data: { text } },
        ...(requestId ? { requestId } : {}),
      },
      context,
    );
  const decide = (taskId: string, allow: boolean) =>
    opened.signal(Number(taskId) as TaskId, Approval, DECISION, { allow }, context);

  telegram?.start({
    onMessage: async (text, id) => {
      if (model) await say(text, id);
      else await push("No model is configured, so I cannot answer.");
    },
    onDecision: async (id, allow) => {
      const result = await decide(id, allow);
      return result === "delivered" ? (allow ? "Approved" : "Declined") : "Already answered";
    },
  });

  return {
    harness: opened,
    root,
    model,
    recipes,
    stopWatch,
    say,
    async answerOf(submission) {
      const settled = await submission.wait(context);
      if (settled.status !== "done" || settled.type !== "input") {
        return { ok: false, reason: settled.status === "unanswered" ? settled.reason : settled.status };
      }
      return { ok: true, text: textOf(await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context)) };
    },
    async startWatch(spec, proof) {
      const now = Date.now();
      const refused = await vetWatch(spec, proof, now, watchDeps);
      if (refused) return { refusal: refused.refusal };
      const id = String(await root.commit((tx) => tx.createTask(Watch, spec, WATCH_TASK_OPTIONS), context));
      await root.commit((tx) => listNewWatch(tx, id, spec, now), context);
      return { id };
    },
    decide,
    async forgetTyping(site) {
      await opened.commit(async (tx) => {
        delete (await tx.doc(TypingAllowances)).sites[site];
      }, context);
    },
    async close() {
      await telegram?.stop();
      await opened.close(context);
      await browsers.closeAll();
    },
  };
}
