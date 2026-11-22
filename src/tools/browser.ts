import { defineTool } from "@earendil-works/pi-durable";
import { arr, bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { askPerson, TypingAllowances, withdrawQuestion, type Announce } from "../approval.ts";
import { describeView, type Browsers, type BrowserSession } from "../browser.ts";

const TEXT_CHARS = 6000;
const IDLE_MS = 30 * 60 * 1000;

const DESCRIPTION = `A real browser, for seeing and using a page the way a person does.
Every action answers with the page's visible text and its numbered controls, then the requests the page made.

open: load "url". click: click a control ("target" is its number from the latest listing, or text to find).
select: choose "value" in a dropdown. read: show the page again ("max_chars" for more text). close: end the session.
type: put "text" into a field. Typing is shown to the person, with your "reason", and happens only if they approve.
Type only what the person gave you or asked you to enter. Set "press_enter" to submit with Enter afterwards.
allow_typing: ask the person once to let you type their own details on one "site" (a hostname) without asking each
time. Give "values" as { label, text } pairs and a "reason". After they agree, typing exactly one of those texts on
that site happens at once. Anything else you type still asks. Do this ahead of a booking, not in the middle of one.

Clicking and selecting need no approval. The browser has no saved logins. If a site shows a captcha or refuses
the browser, say so and hand that step to the person.`;

export function createBrowserTool(deps: { browsers: Browsers; announce?: Announce }) {
  const sessions = new Map<string, { session: BrowserSession; idle?: NodeJS.Timeout }>();

  const close = async (key: string) => {
    const held = sessions.get(key);
    if (!held) return;
    sessions.delete(key);
    clearTimeout(held.idle);
    await held.session.close();
  };

  const sessionFor = async (key: string, start: boolean): Promise<BrowserSession | undefined> => {
    let held = sessions.get(key);
    if (!held && start) sessions.set(key, (held = { session: await deps.browsers.open() }));
    if (!held) return undefined;
    clearTimeout(held.idle);
    held.idle = setTimeout(() => void close(key), IDLE_MS);
    held.idle.unref();
    return held.session;
  };

  const parameters = obj({
    action: oneOf(["open", "click", "select", "type", "read", "close", "allow_typing"]),
    url: opt(str({ description: "For open." })),
    target: opt(str({ description: "A control's number from the latest listing, or visible text to find." })),
    value: opt(str({ description: "For select: the option to choose." })),
    text: opt(str({ description: "For type: what to enter." })),
    press_enter: opt(bool({ description: "For type: press Enter afterwards." })),
    reason: opt(str({ description: "For type: one sentence telling the person why this is being entered." })),
    site: opt(str({ description: "For allow_typing: the hostname the details may be typed on." })),
    values: opt(
      arr(obj({ label: str(), text: str() }), { description: "For allow_typing: the details, each with a short label." }),
    ),
    max_chars: opt(int({ minimum: 500, maximum: 40000, description: `Page text to show. Default ${TEXT_CHARS}.` })),
  });

  return defineTool<typeof parameters>({
    name: "browser",
    description: DESCRIPTION,
    callers: ["model"],
    executionMode: "sequential",
    parameters,
    execute: async (args, api, context) => {
      const text = (value: string, isError = false) => ({ output: [{ type: "text" as const, text: value }], isError });
      const key = String(api.conversationId);
      const shown = async (session: BrowserSession) => text(describeView(await session.view(), args.max_chars ?? TEXT_CHARS));

      if (args.action === "close") {
        await close(key);
        return text("Browser closed.");
      }
      if (args.action === "allow_typing") {
        if (!args.site || !args.values?.length || !args.reason) return text("site, values and reason are required", true);
        const host = new URL(args.site.includes("://") ? args.site : `https://${args.site}`).hostname;
        const values = args.values;
        const answer = await askPerson(
          api,
          context,
          {
            question: `Let me type these on ${host} without asking each time? ${args.reason}`,
            detail: values.map((v) => `${v.label}: ${v.text}`).join("\n"),
          },
          deps.announce,
        );
        if ("park" in answer) return answer.park;
        if (!answer.allowed) return text(`Not allowed: ${answer.why}. Each of these will be asked for when typed.`, true);
        await api.commit(async (tx) => {
          const sites = (await tx.doc(TypingAllowances)).sites;
          const kept = (sites[host] ?? []).filter((old) => !values.some((v) => v.text === old.text));
          sites[host] = [...kept, ...values];
        }, context);
        return text(`Allowed on ${host}: ${values.map((v) => v.label).join(", ")}.`);
      }
      if (args.action === "open") {
        if (!args.url) return text("url is required", true);
        const session = (await sessionFor(key, true))!;
        await session.open(args.url);
        return shown(session);
      }

      const session = await sessionFor(key, false);
      if (!session) return text("No page is open. Use open first.", true);
      if (args.action === "read") return shown(session);
      if (!args.target) return text("target is required", true);

      if (args.action === "click") await session.click(args.target);
      else if (args.action === "select") {
        if (args.value === undefined) return text("value is required", true);
        await session.select(args.target, args.value);
      } else {
        if (args.text === undefined || !args.reason) return text("text and reason are required", true);
        const typed = args.text;
        const allowances = await api.snapshot(TypingAllowances, context);
        const agreed = (allowances?.sites[new URL(session.url()).hostname] ?? []).some((v) => v.text === typed);
        if (api.wake !== undefined || !agreed) {
          const answer = await askPerson(
            api,
            context,
            {
              question: `Type this into "${await session.nameOf(args.target)}"? ${args.reason}`,
              detail: `${typed}\n\non ${session.url()}${args.press_enter ? "\nthen press Enter" : ""}`,
            },
            deps.announce,
          );
          if ("park" in answer) return answer.park;
          if (!answer.allowed) return text(`Nothing was typed: ${answer.why}.`, true);
        }
        await session.type(args.target, typed, args.press_enter === true);
      }
      return shown(session);
    },
    cancel: (_args, api, context) => withdrawQuestion(api, context),
  });
}
