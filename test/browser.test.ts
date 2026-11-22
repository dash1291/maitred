import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ToolResultEntry } from "@earendil-works/pi-durable";
import { PendingApprovals } from "../src/approval.ts";
import type { Maitred } from "../src/harness.ts";
import { publicHost } from "../src/http.ts";
import { scripted, site, until } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

const PAGE = `<!doctype html><title>Reserve</title>
<h1>Test Venue</h1>
<p>Reservations open daily at 10:00 AM for the following week.</p>
<label>Party size <select id="pax"><option>1</option><option>2</option><option>4</option></select></label>
<button id="check">Check availability</button>
<input id="phone" aria-label="Phone number">
<div id="out"></div>
<script>
  fetch("/api/shop").then((r) => r.json());
  document.getElementById("check").onclick = async () => {
    const pax = Number(document.getElementById("pax").value);
    const r = await fetch("/api/availability", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pax }) });
    document.getElementById("out").innerText = "Slots: " + (await r.json()).slots.join(", ");
  };
  document.getElementById("phone").addEventListener("input", (e) => fetch("/api/typed", { method: "POST", body: e.target.value }));
</script>`;

function venueSite() {
  return site((req) => {
    if (req.path === "/api/shop") return { json: { name: "Test Venue" } };
    if (req.path === "/api/availability") return { json: { slots: ["19:00", "20:30"] } };
    if (req.path === "/api/typed") return { json: {} };
    return { html: PAGE };
  });
}

async function results(m: Maitred): Promise<string[]> {
  const page = await m.root.entries({ order: "ascending" }, 100, undefined, context);
  return page.items
    .filter((e) => ToolResultEntry.is(e))
    .map((e) => (e.model?.[0] as { content: { text?: string }[] }).content.map((c) => c.text ?? "").join(""));
}

async function pending(m: Maitred) {
  return Object.entries((await m.harness.snapshot(PendingApprovals, context))?.items ?? {});
}

test("opening a page shows its text, its numbered controls and the requests it made", async () => {
  const venue = await venueSite();
  const { m, modelCalls, modelSays } = await scripted();
  try {
    modelCalls("browser", { action: "open", url: `${venue.url}/reserve` });
    modelSays("Seen.");
    assert.equal((await m.answerOf(await m.say("look at the venue"))).ok, true);

    const [shown] = await results(m);
    assert.match(shown, /Reservations open daily at 10:00 AM for the following week\./);
    assert.match(shown, /\[1\] select "Party size" \(value "1"; options: 1 \| 2 \| 4\)/);
    assert.match(shown, /\[2\] button "Check availability"/);
    assert.match(shown, /\[3\] input:text "Phone number"/);
    assert.ok(shown.includes(`GET ${venue.url}/api/shop -> 200\n  got: {"name":"Test Venue"}`), shown);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("choosing an option and clicking need no approval, and the page's own POST is recorded", async () => {
  const venue = await venueSite();
  const { m, modelCalls, modelSays } = await scripted();
  try {
    modelCalls("browser", { action: "open", url: `${venue.url}/reserve` });
    modelCalls("browser", { action: "select", target: "1", value: "4" });
    modelCalls("browser", { action: "click", target: "2" });
    modelSays("There are tables at 19:00 and 20:30.");
    assert.equal((await m.answerOf(await m.say("any tables for 4?"))).ok, true);

    const shown = (await results(m))[2];
    assert.match(shown, /Slots: 19:00, 20:30/);
    assert.ok(shown.includes(`POST ${venue.url}/api/availability -> 200\n  sent: {"pax":4}\n  got: {"slots":["19:00","20:30"]}`), shown);
    assert.equal((await pending(m)).length, 0);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("a control can be clicked by its visible text", async () => {
  const venue = await venueSite();
  const { m, modelCalls, modelSays } = await scripted();
  try {
    modelCalls("browser", { action: "open", url: `${venue.url}/reserve` });
    modelCalls("browser", { action: "click", target: "Check availability" });
    modelSays("Done.");
    assert.equal((await m.answerOf(await m.say("check"))).ok, true);
    assert.match((await results(m))[1], /Slots: 19:00, 20:30/);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("a control is clicked by the name it is listed under, even when that is not its visible text", async () => {
  const venue = await site(() => ({
    html: `<button aria-label="Monday 30" onclick="document.getElementById('out').innerText = 'Picked Monday 30'">30</button><div id="out"></div>`,
  }));
  const { m, modelCalls, modelSays } = await scripted();
  try {
    modelCalls("browser", { action: "open", url: `${venue.url}/calendar` });
    modelCalls("browser", { action: "click", target: "Monday 30" });
    modelSays("Picked.");
    assert.equal((await m.answerOf(await m.say("pick monday"))).ok, true);
    const shown = await results(m);
    assert.match(shown[0], /\[1\] button "Monday 30"/);
    assert.match(shown[1], /Picked Monday 30/);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("typing waits for the person and happens once they approve", async () => {
  const venue = await venueSite();
  const { m, modelCalls, modelSays } = await scripted();
  try {
    modelCalls("browser", { action: "open", url: `${venue.url}/reserve` });
    modelCalls("browser", { action: "type", target: "3", text: "9876543210", reason: "The booking form needs your phone number." });
    modelSays("Entered.");
    const submission = await m.say("book it, my number is 9876543210");

    await until(async () => (await pending(m)).length === 1, "the typing to be shown for approval");
    const [[id, shown]] = await pending(m);
    assert.equal(shown.question, 'Type this into "Phone number"? The booking form needs your phone number.');
    assert.equal(shown.detail, `9876543210\n\non ${venue.url}/reserve`);
    assert.equal(venue.requests.filter((r) => r.path === "/api/typed").length, 0);

    assert.equal(await m.decide(id, true), "delivered");
    assert.equal((await m.answerOf(submission)).ok, true);
    assert.deepEqual(venue.requests.filter((r) => r.path === "/api/typed").map((r) => r.body), ["9876543210"]);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("details the person pre-approved for a site are typed there without asking", async () => {
  const venue = await venueSite();
  const { m, modelCalls, modelSays } = await scripted();
  try {
    modelCalls("browser", {
      action: "allow_typing",
      site: venue.hostname,
      values: [{ label: "Phone", text: "9876543210" }],
      reason: "For booking at the test venue.",
    });
    modelSays("Thanks.");
    const asked = await m.say("my phone is 9876543210, use it for bookings here");
    await until(async () => (await pending(m)).length === 1, "the pre-approval to be asked");
    const [[id, shown]] = await pending(m);
    assert.equal(shown.question, `Let me type these on ${venue.hostname} without asking each time? For booking at the test venue.`);
    assert.equal(shown.detail, "Phone: 9876543210");
    assert.equal(await m.decide(id, true), "delivered");
    assert.equal((await m.answerOf(asked)).ok, true);

    modelCalls("browser", { action: "open", url: `${venue.url}/reserve` });
    modelCalls("browser", { action: "type", target: "3", text: "9876543210", reason: "The booking form needs your phone number." });
    modelSays("Entered.");
    assert.equal((await m.answerOf(await m.say("book it"))).ok, true);
    assert.equal((await pending(m)).length, 0);
    assert.deepEqual(venue.requests.filter((r) => r.path === "/api/typed").map((r) => r.body), ["9876543210"]);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("a pre-approval covers only that text on that site", async () => {
  const venue = await venueSite();
  const { m, modelCalls, modelSays } = await scripted();
  try {
    modelCalls("browser", {
      action: "allow_typing",
      site: "other.example",
      values: [{ label: "Phone", text: "9876543210" }],
      reason: "For bookings elsewhere.",
    });
    modelSays("Thanks.");
    const asked = await m.say("pre-approve my phone for other.example");
    await until(async () => (await pending(m)).length === 1, "the pre-approval to be asked");
    await m.decide((await pending(m))[0][0], true);
    await m.answerOf(asked);

    modelCalls("browser", { action: "open", url: `${venue.url}/reserve` });
    modelCalls("browser", { action: "type", target: "3", text: "9876543210", reason: "The form needs a phone number." });
    modelSays("Not entered.");
    const submission = await m.say("book it");
    await until(async () => (await pending(m)).length === 1, "the typing to be asked, since this is another site");
    await m.decide((await pending(m))[0][0], false);
    await m.answerOf(submission);
    assert.equal(venue.requests.filter((r) => r.path === "/api/typed").length, 0);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("nothing is typed when the person declines", async () => {
  const venue = await venueSite();
  const { m, modelCalls, modelSays } = await scripted();
  try {
    modelCalls("browser", { action: "open", url: `${venue.url}/reserve` });
    modelCalls("browser", { action: "type", target: "3", text: "9876543210", reason: "The booking form needs a phone number." });
    modelSays("Not entered.");
    const submission = await m.say("book it");

    await until(async () => (await pending(m)).length === 1, "the typing to be shown for approval");
    assert.equal(await m.decide((await pending(m))[0][0], false), "delivered");
    assert.equal((await m.answerOf(submission)).ok, true);
    assert.equal(venue.requests.filter((r) => r.path === "/api/typed").length, 0);
    assert.match((await results(m))[1], /Nothing was typed: the person declined\./);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("the browser does not open a private address", async () => {
  const local = await site(() => ({ html: "<p>console with a secret token</p>" }));
  const { m, modelCalls, modelSays } = await scripted({ reachable: publicHost });
  try {
    modelCalls("browser", { action: "open", url: `${local.url}/` });
    modelSays("Refused.");
    assert.equal((await m.answerOf(await m.say("open it"))).ok, true);
    assert.match((await results(m))[0], /127\.0\.0\.1 is not a public host/);
    assert.equal(local.requests.length, 0);
  } finally {
    await m.close();
    await local.close();
  }
});

test("a page cannot make the browser fetch from a host that is not reachable", async () => {
  const hidden = await site(() => ({ json: { secret: true } }), "localhost");
  const venue = await site(() => ({ html: `<p>hello</p><script>fetch("${hidden.url}/secret").catch(() => {});</script>` }));
  const onlyVenue = async (hostname: string) => {
    if (hostname !== "127.0.0.1") throw new Error(`${hostname} is not reachable`);
  };
  const { m, modelCalls, modelSays } = await scripted({ reachable: onlyVenue });
  try {
    modelCalls("browser", { action: "open", url: `${venue.url}/` });
    modelSays("Seen.");
    assert.equal((await m.answerOf(await m.say("open it"))).ok, true);
    assert.match((await results(m))[0], /hello/);
    assert.equal(hidden.requests.length, 0);
  } finally {
    await m.close();
    await venue.close();
    await hidden.close();
  }
});
