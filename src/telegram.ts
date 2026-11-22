// Telegram as the person's channel, on grammY. Long polling only, so the server needs no inbound port.

import { Bot, InlineKeyboard } from "grammy";

export type TelegramOptions = {
  token: string;
  /** The one chat that may talk to the assistant. Unset: pairing mode, which only tells a chat its own id. */
  chatId?: string;
  apiRoot?: string;
  retryMs?: number;
};

export type TelegramHandlers = {
  /** A text message from the allowed chat. `id` is stable across redelivery. */
  onMessage(text: string, id: string): Promise<void>;
  /** A tap on an approve or decline button. Returns what to show the person. */
  onDecision(approvalId: string, allow: boolean): Promise<string>;
};

export type Telegram = {
  /** Send to the allowed chat; with `approvalId`, with approve and decline buttons. Never throws. */
  send(text: string, approvalId?: string): Promise<void>;
  start(handlers: TelegramHandlers): void;
  stop(): Promise<void>;
};

const MESSAGE_LIMIT = 4000;

export function createTelegram(options: TelegramOptions): Telegram {
  const bot = new Bot(options.token, options.apiRoot ? { client: { apiRoot: options.apiRoot } } : undefined);
  bot.catch((failure) => console.error("[maitred] telegram update failed:", String(failure.error)));
  const allowed = (chat: number | undefined) => options.chatId !== undefined && String(chat) === options.chatId;
  let stopped = false;

  return {
    async send(text, approvalId) {
      if (options.chatId === undefined || !text.trim()) return;
      const parts: string[] = [];
      for (let rest = text; rest.length > 0; rest = rest.slice(MESSAGE_LIMIT)) parts.push(rest.slice(0, MESSAGE_LIMIT));
      try {
        for (const [i, part] of parts.entries()) {
          const last = approvalId !== undefined && i === parts.length - 1;
          await bot.api.sendMessage(
            options.chatId,
            part,
            last
              ? { reply_markup: new InlineKeyboard().text("Approve", `approve:${approvalId}`).text("Decline", `decline:${approvalId}`) }
              : undefined,
          );
        }
      } catch (e) {
        console.error("[maitred] telegram send failed:", String(e));
      }
    },

    start(handlers) {
      bot.on("message:text", async (ctx) => {
        if (options.chatId === undefined) {
          await ctx.reply(`This chat's id is ${ctx.chat.id}. Set MAITRED_TELEGRAM_CHAT=${ctx.chat.id} on the server to pair it.`);
        } else if (allowed(ctx.chat.id)) {
          await handlers.onMessage(ctx.message.text, `telegram:${ctx.update.update_id}`);
        }
      });
      bot.on("callback_query:data", async (ctx) => {
        const choice = ctx.callbackQuery.data.match(/^(approve|decline):(.+)$/);
        if (!choice || !allowed(ctx.chat?.id)) return void (await ctx.answerCallbackQuery());
        await ctx.answerCallbackQuery({ text: await handlers.onDecision(choice[2], choice[1] === "approve") });
      });
      // grammY gives up on a 409, which Telegram also returns briefly when one poller replaces another on a restart.
      void (async () => {
        while (!stopped) {
          await bot
            .start({ allowed_updates: ["message", "callback_query"] })
            .catch((e) => console.error("[maitred] telegram polling failed, retrying:", String(e)));
          if (!stopped) await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? 10_000));
        }
      })();
    },

    async stop() {
      stopped = true;
      if (bot.isRunning()) await bot.stop();
    },
  };
}
