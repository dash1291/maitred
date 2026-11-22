// Headless Chromium as the assistant and its watches use it: act on a page like a person, then read what it shows.

import type { JsonValue } from "@earendil-works/chord/json";
import type { Browser, Locator, Request as PageRequest } from "playwright";
import type { HostPolicy } from "./http.ts";

const MAX_CONTROLS = 150;
const MAX_REQUESTS = 40;
const BODY_CHARS = 600;

export type Control = { ref: number; kind: string; name: string; value?: string; options?: string[]; disabled?: boolean };

export type SeenRequest = {
  method: string;
  url: string;
  kind: string;
  body?: string;
  status?: number;
  response?: string;
  failed?: string;
  carried?: boolean;
};

/** What a page shows at one moment. */
export type PageView = {
  url: string;
  title: string;
  text: string;
  controls: Control[];
  moreControls: number;
  frames: string[];
  requests: SeenRequest[];
};

/** One thing a person does on a page. A watch replays a list of these. */
export type Step =
  | { action: "open"; url: string }
  | { action: "click"; target: string }
  | { action: "select"; target: string; value: string };

export type BrowserSession = {
  url(): string;
  open(url: string): Promise<void>;
  click(target: string): Promise<void>;
  select(target: string, value: string): Promise<void>;
  /** The name a person would know a field by, for asking before typing into it. */
  nameOf(target: string): Promise<string>;
  type(target: string, text: string, pressEnter: boolean): Promise<void>;
  view(): Promise<PageView>;
  close(): Promise<void>;
};

// Runs in the page. Numbers every visible control with a data-maitred-ref attribute, so a later action can find the
// one picked from the listing.
const LIST_CONTROLS = `((max) => {
  const roles = ["button", "link", "option", "tab", "checkbox", "radio", "combobox", "menuitem", "switch", "textbox"];
  const clean = (s) => String(s ?? "").replace(/\\s+/g, " ").trim().slice(0, 90);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const labelText = (el) => {
    if (!el.labels || !el.labels[0]) return "";
    const copy = el.labels[0].cloneNode(true);
    copy.querySelectorAll("select, input, textarea").forEach((inner) => inner.remove());
    return copy.textContent;
  };
  const controls = [];
  let more = 0;
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) walk(el.shadowRoot);
      el.removeAttribute("data-maitred-ref");
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role");
      const native = (tag === "a" && el.hasAttribute("href")) || tag === "button" || tag === "select" ||
        tag === "textarea" || (tag === "input" && el.type !== "hidden");
      const pointer = !native && getComputedStyle(el).cursor === "pointer" &&
        (!el.parentElement || getComputedStyle(el.parentElement).cursor !== "pointer") &&
        !el.closest("a[href], button");
      if (!(native || roles.includes(role) || el.hasAttribute("onclick") || pointer) || !visible(el)) continue;
      if (controls.length >= max) { more++; continue; }
      const ref = controls.length + 1;
      el.setAttribute("data-maitred-ref", String(ref));
      const label = el.getAttribute("aria-label") || labelText(el) || el.getAttribute("placeholder") ||
        (tag === "select" ? "" : el.innerText) || el.getAttribute("title") || el.getAttribute("name") || "";
      const control = { ref, kind: role || (tag === "input" ? "input:" + el.type : tag === "a" ? "link" : pointer ? "clickable" : tag), name: clean(label) };
      if (tag === "select") {
        control.options = [...el.options].slice(0, 30).map((o) => clean(o.label));
        control.value = clean(el.selectedOptions[0] && el.selectedOptions[0].label);
      } else if (tag === "input" || tag === "textarea") {
        control.value = el.type === "checkbox" || el.type === "radio" ? String(el.checked) : clean(el.value);
      }
      if (el.disabled || el.getAttribute("aria-disabled") === "true") control.disabled = true;
      controls.push(control);
    }
  };
  walk(document);
  return { controls, more, text: document.body ? document.body.innerText : "" };
})`;

export function createBrowsers(deps: { reachable: HostPolicy; launch?: () => Promise<Browser> }) {
  const launch = deps.launch ?? (async () => (await import("playwright")).chromium.launch({ headless: true }));
  const live = new Set<BrowserSession>();

  const open = async (): Promise<BrowserSession> => {
    const browser = await launch();
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    let page = await context.newPage();
    let seen: SeenRequest[] = [];

    const verdicts = new Map<string, Promise<boolean>>();
    const reachable = (url: string) => {
      const parsed = new URL(url);
      if (!/^(https?|wss?):$/.test(parsed.protocol)) return Promise.resolve(true);
      const host = parsed.hostname.replace(/^\[|\]$/g, "");
      let verdict = verdicts.get(host);
      if (!verdict) verdicts.set(host, (verdict = deps.reachable(host).then(() => true, () => false)));
      return verdict;
    };
    // Pictures, fonts and media are never read, so they are not fetched: a visit stays light on the site.
    await context.route("**/*", async (route) => {
      const kind = route.request().resourceType();
      if (kind === "image" || kind === "font" || kind === "media") return route.abort("blockedbyclient");
      return (await reachable(route.request().url())) ? route.continue() : route.abort("blockedbyclient");
    });
    await context.routeWebSocket(/.*/, async (socket) => {
      if (await reachable(socket.url())) socket.connectToServer();
      else await socket.close();
    });

    const entries = new WeakMap<PageRequest, SeenRequest>();
    context.on("request", (request) => {
      const kind = request.resourceType();
      if (kind !== "xhr" && kind !== "fetch" && kind !== "document") return;
      const entry: SeenRequest = { method: request.method(), url: request.url(), kind };
      const body = request.postData();
      if (body) entry.body = body.slice(0, BODY_CHARS);
      entries.set(request, entry);
      seen.push(entry);
    });
    context.on("response", async (response) => {
      const entry = entries.get(response.request());
      if (!entry) return;
      entry.status = response.status();
      const type = response.headers()["content-type"] ?? "";
      if (entry.kind !== "document" && /json|text\/plain/.test(type)) {
        entry.response = (await response.text().catch(() => "")).slice(0, BODY_CHARS);
      }
    });
    context.on("requestfailed", (request) => {
      const entry = entries.get(request);
      if (entry) entry.failed = request.failure()?.errorText ?? "failed";
    });
    context.on("page", (opened) => {
      page = opened;
    });

    const settle = async () => {
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(400);
      await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
    };

    const locate = async (target: string): Promise<Locator> => {
      const wanted = target.trim();
      if (/^\d+$/.test(wanted)) {
        const control = page.locator(`[data-maitred-ref="${wanted}"]`);
        if ((await control.count()) !== 1) throw new Error(`no control numbered ${wanted} on the page now; read it again`);
        return control;
      }
      // A control is found by the name it is listed under, which can be a label a person hears but does not see
      // (a calendar day shown as "30" and named "Monday 30").
      const listed = (await page.evaluate(`${LIST_CONTROLS}(${MAX_CONTROLS})`)) as { controls: Control[] };
      const named =
        listed.controls.find((c) => c.name === wanted) ??
        listed.controls.find((c) => c.name.toLowerCase() === wanted.toLowerCase());
      if (named) return page.locator(`[data-maitred-ref="${named.ref}"]`);
      const exact = page.getByText(wanted, { exact: true });
      const found = (await exact.count()) > 0 ? exact : page.getByText(wanted, { exact: false });
      if ((await found.count()) === 0) throw new Error(`nothing on the page says "${wanted}"`);
      return found.first();
    };

    const session: BrowserSession = {
      url: () => page.url(),
      async open(url) {
        await deps.reachable(new URL(url).hostname.replace(/^\[|\]$/g, ""));
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await settle();
      },
      async click(target) {
        await (await locate(target)).click({ timeout: 8_000 });
        await settle();
      },
      async select(target, value) {
        const control = await locate(target);
        await control
          .selectOption({ label: value }, { timeout: 8_000 })
          .catch(() => control.selectOption(value, { timeout: 8_000 }));
        await settle();
      },
      async nameOf(target) {
        const field = await locate(target);
        for (const attribute of ["aria-label", "placeholder", "name"]) {
          const value = await field.getAttribute(attribute).catch(() => null);
          if (value) return value;
        }
        return target;
      },
      async type(target, text, pressEnter) {
        const field = await locate(target);
        await field.fill(text, { timeout: 8_000 });
        if (pressEnter) await field.press("Enter");
        await settle();
      },
      async view() {
        const listed = (await page.evaluate(`${LIST_CONTROLS}(${MAX_CONTROLS})`)) as {
          controls: Control[];
          more: number;
          text: string;
        };
        const requests = seen;
        // A request still in flight is listed now and once more with the next view, when its answer is usually in.
        seen = requests.filter((r) => r.status === undefined && r.failed === undefined && !r.carried);
        for (const r of seen) r.carried = true;
        return {
          url: page.url(),
          title: await page.title(),
          text: listed.text,
          controls: listed.controls,
          moreControls: listed.more,
          frames: page.frames().slice(1).map((f) => f.url()).filter((u) => u.startsWith("http")),
          requests,
        };
      },
      async close() {
        live.delete(session);
        await browser.close().catch(() => {});
      },
    };
    live.add(session);
    return session;
  };

  let queue: Promise<unknown> = Promise.resolve();

  return {
    open,
    /**
     * Replay `steps` in a fresh browser and return what the page shows at the end. `{name}` in a URL, target or value
     * is filled from `params`. One walk runs at a time. A step that cannot be done throws: a watch must fail loudly
     * when the page is not what it expected.
     */
    walk(steps: readonly Step[], params: JsonValue): Promise<PageView> {
      const values = params !== null && typeof params === "object" && !Array.isArray(params) ? params : {};
      const fill = (text: string) =>
        text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
      const run = async () => {
        const session = await open();
        try {
          for (const [i, step] of steps.entries()) {
            try {
              if (step.action === "open") await session.open(fill(step.url));
              else if (step.action === "click") await session.click(fill(step.target));
              else await session.select(fill(step.target), fill(step.value));
            } catch (e) {
              throw new Error(`step ${i + 1} (${step.action}) failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
            }
          }
          return await session.view();
        } finally {
          await session.close();
        }
      };
      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    },
    closeAll: () => Promise.all([...live].map((s) => s.close())).then(() => {}),
  };
}

export type Browsers = ReturnType<typeof createBrowsers>;

export function describeView(view: PageView, maxChars: number): string {
  const lines = [`URL: ${view.url}`, `Title: ${view.title}`, ""];
  lines.push(view.text.length > maxChars ? `Text (first ${maxChars} of ${view.text.length} chars):` : "Text:");
  lines.push(view.text.slice(0, maxChars), "", "Controls:");
  for (const c of view.controls) {
    const extra = [
      c.value ? `value "${c.value}"` : "",
      c.options ? `options: ${c.options.join(" | ")}` : "",
      c.disabled ? "disabled" : "",
    ].filter(Boolean);
    lines.push(`[${c.ref}] ${c.kind} "${c.name}"${extra.length ? ` (${extra.join("; ")})` : ""}`);
  }
  if (view.controls.length === 0) lines.push("(none)");
  if (view.moreControls > 0) lines.push(`(${view.moreControls} more controls not listed)`);
  if (view.frames.length > 0) lines.push("", "Embedded frames (open one to see inside it):", ...view.frames);
  lines.push("", "Requests since the last action:");
  for (const r of view.requests.slice(-MAX_REQUESTS)) {
    lines.push(`${r.method} ${r.url} -> ${r.failed ?? r.status ?? "still waiting"}`);
    if (r.body) lines.push(`  sent: ${r.body}`);
    if (r.response) lines.push(`  got: ${r.response}`);
  }
  if (view.requests.length === 0) lines.push("(none)");
  if (view.requests.length > MAX_REQUESTS) lines.push(`(${view.requests.length - MAX_REQUESTS} earlier requests not listed)`);
  return lines.join("\n");
}
