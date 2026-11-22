import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PendingApprovals } from "../src/approval.ts";
import { scripted, site, until } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const ME = 4242;
const chat = (id: number) => ({ id, type: "private" });

/** A stand-in for the Telegram Bot API: records what the bot sends and hands it the updates a test delivers. */
async function fakeTelegram() {
  const queue: Record<string, unknown>[] = [];
  const sent: { chat_id: string | number; text: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }[] = [];
  const taps: { text?: string }[] = [];
  let updateId = 100;
  let conflicts = 0;
  const api = await site(async (req) => {
    const method = req.path.split("/").pop();
    const body = req.body ? JSON.parse(req.body) : {};
    if (method === "getMe") return { json: { ok: true, result: { id: 1, is_bot: true, first_name: "maitred", username: "maitred_bot" } } };
    if (method === "getUpdates") {
      if (conflicts-- > 0) {
        return { status: 409, json: { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" } };
      }
      if (queue.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
      return { json: { ok: true, result: queue.splice(0) } };
    }
    if (method === "sendMessage") {
      sent.push(body);
      return { json: { ok: true, result: { message_id: sent.length, date: 0, chat: chat(Number(body.chat_id)), text: body.text } } };
    }
    if (method === "answerCallbackQuery") taps.push(body);
    return { json: { ok: true, result: true } };
  });
  const from = { id: ME, is_bot: false, first_name: "A" };
  return {
    options: (chatId?: string) => ({ token: "TEST", apiRoot: api.url, ...(chatId ? { chatId } : {}) }),
    sent,
    taps,
    conflictOnce: () => void (conflicts = 1),
    message: (text: string, chatId = ME) =>
      queue.push({ update_id: updateId++, message: { message_id: 1, date: 0, chat: chat(chatId), from, text } }),
    tap: (data: string, chatId = ME) =>
      queue.push({
        update_id: updateId++,
        callback_query: { id: "tap", from, chat_instance: "x", data, message: { message_id: 1, date: 0, chat: chat(chatId) } },
      }),
    close: api.close,
  };
}

test("a message from the paired chat reaches the assistant, and its answer comes back to that chat", async () => {
  const telegram = await fakeTelegram();
  const { m, modelSays } = await scripted({ telegram: telegram.options(String(ME)) });
  try {
    modelSays("Which day would you like?");
    telegram.message("table for 2 at guerilla diner");
    await until(() => telegram.sent.length === 1, "the answer to be sent");
    assert.deepEqual(telegram.sent[0], { chat_id: String(ME), text: "Which day would you like?" });

    const page = await m.root.entries({ order: "ascending" }, 10, undefined, context);
    assert.deepEqual(page.items.find((e) => e.kind === "maitred.user")?.data, { text: "table for 2 at guerilla diner" });
  } finally {
    await m.close();
    await telegram.close();
  }
});

test("polling recovers after Telegram reports another poller", async () => {
  const telegram = await fakeTelegram();
  telegram.conflictOnce();
  const { m, modelSays } = await scripted({ telegram: { ...telegram.options(String(ME)), retryMs: 50 } });
  try {
    modelSays("Still here.");
    telegram.message("are you there?");
    await until(() => telegram.sent.length === 1, "the answer after the conflict");
    assert.equal(telegram.sent[0].text, "Still here.");
  } finally {
    await m.close();
    await telegram.close();
  }
});

test("a message from any other chat is ignored", async () => {
  const telegram = await fakeTelegram();
  const { m, modelSays } = await scripted({ telegram: telegram.options(String(ME)) });
  try {
    modelSays("Hello.");
    telegram.message("let me in", 999);
    telegram.message("hi");
    await until(() => telegram.sent.length === 1, "the answer to the paired chat");
    const page = await m.root.entries({ order: "ascending" }, 10, undefined, context);
    assert.deepEqual(page.items.filter((e) => e.kind === "maitred.user").map((e) => e.data), [{ text: "hi" }]);
    assert.deepEqual(telegram.sent.map((s) => s.chat_id), [String(ME)]);
  } finally {
    await m.close();
    await telegram.close();
  }
});

test("a bot with no paired chat only tells a chat its id", async () => {
  const telegram = await fakeTelegram();
  const { m } = await scripted({ telegram: telegram.options() });
  try {
    telegram.message("hello");
    await until(() => telegram.sent.length === 1, "the pairing reply");
    assert.match(telegram.sent[0].text, /This chat's id is 4242\. Set MAITRED_TELEGRAM_CHAT=4242/);
    const page = await m.root.entries({ order: "ascending" }, 10, undefined, context);
    assert.equal(page.items.filter((e) => e.kind === "maitred.user").length, 0);
  } finally {
    await m.close();
    await telegram.close();
  }
});

test("a watch match is pushed to the chat at once", async () => {
  const telegram = await fakeTelegram();
  let open = false;
  const venue = await site((req) => ({ json: { open: open || req.path.endsWith("day=proof") } }));
  const { m, modelSays } = await scripted({ telegram: telegram.options(String(ME)) });
  try {
    modelSays("Bookings just opened; here is the page.");
    const started = await m.startWatch(
      {
        label: "Table for 2 at the test venue",
        rule: `const page = await tools.get("${venue.url}/slots?day=" + input.params.day); return page.open ? [{ time: "19:00" }] : [];`,
        hosts: [venue.hostname],
        params: { pax: 2, day: "wanted" },
        timezone: "Asia/Kolkata",
        intervalSeconds: 4,
        alert: "Bookings are open: https://venue.example/book",
      },
      { pax: 2, day: "proof" },
    );
    assert.ok("id" in started, JSON.stringify(started));
    open = true;
    await until(() => telegram.sent.length === 2, "the alert and then the assistant's answer");
    assert.equal(
      telegram.sent[0].text,
      'Bookings are open: https://venue.example/book\n\nTable for 2 at the test venue\n[{"time":"19:00"}]',
    );
    assert.equal(telegram.sent[1].text, "Bookings just opened; here is the page.");
  } finally {
    await m.close();
    await venue.close();
    await telegram.close();
  }
});

test("an approval arrives with buttons, and tapping Approve lets the typing happen", async () => {
  const telegram = await fakeTelegram();
  const venue = await site((req) =>
    req.path === "/typed"
      ? { json: {} }
      : { html: `<input aria-label="Phone number" oninput="fetch('/typed', { method: 'POST', body: this.value })">` },
  );
  const { m, modelCalls, modelSays } = await scripted({ telegram: telegram.options(String(ME)) });
  try {
    modelCalls("browser", { action: "open", url: `${venue.url}/book` });
    modelCalls("browser", { action: "type", target: "1", text: "9876543210", reason: "The booking form needs your phone number." });
    modelSays("Entered.");
    telegram.message("book it, my number is 9876543210");

    await until(() => telegram.sent.length === 1, "the approval to be offered");
    const offer = telegram.sent[0];
    assert.equal(
      offer.text,
      `Type this into "Phone number"? The booking form needs your phone number.\n\n9876543210\n\non ${venue.url}/book`,
    );
    const [approve, decline] = offer.reply_markup!.inline_keyboard[0];
    assert.deepEqual([approve.text, decline.text], ["Approve", "Decline"]);
    assert.equal(venue.requests.filter((r) => r.path === "/typed").length, 0);

    telegram.tap(approve.callback_data);
    await until(() => telegram.sent.length === 2, "the answer after approval");
    assert.deepEqual(venue.requests.filter((r) => r.path === "/typed").map((r) => r.body), ["9876543210"]);
    assert.equal(telegram.taps[0].text, "Approved");
    assert.equal(telegram.sent[1].text, "Entered.");
    assert.equal(Object.keys((await m.harness.snapshot(PendingApprovals, context))?.items ?? {}).length, 0);
  } finally {
    await m.close();
    await venue.close();
    await telegram.close();
  }
});
