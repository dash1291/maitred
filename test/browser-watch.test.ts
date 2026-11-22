import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Maitred } from "../src/harness.ts";
import { WatchList, type WatchSpec } from "../src/watch.ts";
import { scripted, site, until, type Site } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

const WANTED = { date: "2026-11-29" };
const BOOKABLE_NOW = { date: "2026-11-23" };

// A booking page like the real ones: the date is in the URL, and the times appear only after a click. Every time is
// listed; the ones that cannot be booked are disabled.
const RESERVE = `<!doctype html><title>Reserve</title>
<h1>Test Venue</h1>
<button id="open">Select a time</button>
<div id="times"></div>
<script>
  const date = new URLSearchParams(location.search).get("date");
  document.getElementById("open").onclick = async () => {
    const slots = await (await fetch("/api/times?date=" + date)).json();
    const box = document.getElementById("times");
    box.innerHTML = "<h2>Times for " + date + "</h2>";
    for (const slot of slots) {
      const button = document.createElement("button");
      button.textContent = slot.time;
      button.disabled = !slot.free;
      box.append(button);
    }
  };
</script>`;

async function venueWith(state: { opened: string[] }) {
  return site((req) => {
    const url = new URL(req.path, "http://venue");
    if (url.pathname !== "/api/times") return { html: RESERVE };
    const free = state.opened.includes(url.searchParams.get("date") ?? "");
    return { json: [{ time: "19:00", free }, { time: "20:00", free: false }] };
  });
}

function specFor(venue: Site, overrides: Partial<WatchSpec> = {}): WatchSpec {
  return {
    label: "Table at the test venue",
    steps: [
      { action: "open", url: `${venue.url}/reserve?date={date}` },
      { action: "click", target: "Select a time" },
    ],
    rule: `const page = input.page;
if (!page.text.includes("Times for " + input.params.date)) throw new Error("the list of times did not open");
return page.controls
  .filter((c) => c.kind === "button" && /^\\d\\d:\\d\\d$/.test(c.name) && !c.disabled)
  .map((c) => ({ date: input.params.date, time: c.name }));`,
    hosts: [],
    params: WANTED,
    timezone: "Asia/Kolkata",
    intervalSeconds: 60,
    alert: "A table is free.",
    ...overrides,
  };
}

async function watchOf(m: Maitred, id: string) {
  return (await m.harness.snapshot(WatchList, context))?.items[id];
}

test("a watch walks the page like a person and reports the time that opens", async () => {
  const state = { opened: [BOOKABLE_NOW.date] };
  const venue = await venueWith(state);
  const { m, modelSays } = await scripted();
  try {
    modelSays("A table opened.");
    const started = await m.startWatch(specFor(venue), BOOKABLE_NOW);
    assert.ok("id" in started, JSON.stringify(started));

    state.opened.push(WANTED.date);
    await until(async () => (await watchOf(m, started.id))?.state === "matched", "the match");
    assert.deepEqual((await watchOf(m, started.id))?.matches, [{ date: "2026-11-29", time: "19:00" }]);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("a watch does not start when the page shows nothing free even for a date that is bookable now", async () => {
  const venue = await venueWith({ opened: [] });
  const { m } = await scripted();
  try {
    const started = await m.startWatch(specFor(venue), BOOKABLE_NOW);
    assert.ok("refusal" in started);
    assert.match(started.refusal, /it has not been shown to detect availability/);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("a watch does not start when one of its steps cannot be done on the page", async () => {
  const venue = await venueWith({ opened: [BOOKABLE_NOW.date] });
  const { m } = await scripted();
  try {
    const spec = specFor(venue, {
      steps: [
        { action: "open", url: `${venue.url}/reserve?date={date}` },
        { action: "click", target: "Pick a slot" },
      ],
    });
    const started = await m.startWatch(spec, BOOKABLE_NOW);
    assert.ok("refusal" in started);
    assert.match(started.refusal, /step 2 \(click\) failed: nothing on the page says "Pick a slot"/);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("a watch does not start when the path ends on a page its rule does not recognise", async () => {
  const venue = await venueWith({ opened: [BOOKABLE_NOW.date] });
  const { m } = await scripted();
  try {
    const spec = specFor(venue, { steps: [{ action: "open", url: `${venue.url}/reserve?date={date}` }] });
    const started = await m.startWatch(spec, BOOKABLE_NOW);
    assert.ok("refusal" in started);
    assert.match(started.refusal, /the list of times did not open/);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("a watch may not visit a page more than once a minute", async () => {
  const venue = await venueWith({ opened: [BOOKABLE_NOW.date] });
  const { m } = await scripted();
  try {
    const started = await m.startWatch(specFor(venue, { intervalSeconds: 30 }), BOOKABLE_NOW);
    assert.ok("refusal" in started);
    assert.match(started.refusal, /intervalSeconds must be at least 60/);
    assert.equal(venue.requests.length, 0);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("a watch step must name its target by the text a person sees", async () => {
  const venue = await venueWith({ opened: [BOOKABLE_NOW.date] });
  const { m } = await scripted();
  try {
    const spec = specFor(venue, {
      steps: [
        { action: "open", url: `${venue.url}/reserve?date={date}` },
        { action: "click", target: "2" },
      ],
    });
    const started = await m.startWatch(spec, BOOKABLE_NOW);
    assert.ok("refusal" in started);
    assert.match(started.refusal, /name the target by the text a person sees/);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("the assistant starts a browser watch through its tool", async () => {
  const venue = await venueWith({ opened: [BOOKABLE_NOW.date] });
  const { m, modelCalls, modelSays } = await scripted();
  try {
    const spec = specFor(venue);
    modelCalls("watch", {
      action: "start",
      label: spec.label,
      steps: spec.steps as never,
      rule: spec.rule,
      params: WANTED,
      proof: BOOKABLE_NOW,
      timezone: spec.timezone,
      intervalSeconds: 300,
      alert: spec.alert,
    });
    modelSays("Watching.");
    assert.equal((await m.answerOf(await m.say("watch the venue"))).ok, true);
    const watches = Object.values((await m.harness.snapshot(WatchList, context))?.items ?? {});
    assert.equal(watches.length, 1);
    assert.equal(watches[0].intervalSeconds, 300);
  } finally {
    await m.close();
    await venue.close();
  }
});
