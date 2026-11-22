import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Maitred } from "../src/harness.ts";
import { WatchList, type WatchSpec } from "../src/watch.ts";
import { scripted, site, until, type Site } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

/** The date the person wants, which is not bookable yet, and one that is bookable today. */
const WANTED = { date: "2026-11-29", pax: 2 };
const BOOKABLE_NOW = { date: "2026-11-23", pax: 2 };

/** A venue whose /slots says whether a date is open. `state.opened` holds the dates that are. */
async function venueWith(state: { opened: string[]; broken?: boolean }) {
  return site((req) => {
    if (state.broken) return { status: 500, text: "down" };
    const date = new URL(req.path, "http://venue").searchParams.get("date") ?? JSON.parse(req.body || "{}").date;
    return { json: { open: state.opened.includes(date) } };
  });
}

function specFor(venue: Site, overrides: Partial<WatchSpec> = {}): WatchSpec {
  return {
    label: "Table for 2 at the test venue",
    rule: `const page = await tools.get("${venue.url}/slots?date=" + input.params.date);
return page.open ? [{ date: input.params.date, time: "19:00" }] : [];`,
    hosts: [venue.hostname],
    params: WANTED,
    timezone: "Asia/Kolkata",
    intervalSeconds: 4,
    alert: "Bookings are open: https://venue.example/book",
    ...overrides,
  };
}

async function watchOf(m: Maitred, id: string) {
  return (await m.harness.snapshot(WatchList, context))?.items[id];
}

async function watches(m: Maitred) {
  return Object.keys((await m.harness.snapshot(WatchList, context))?.items ?? {});
}

async function reports(m: Maitred): Promise<string[]> {
  const page = await m.root.entries({ order: "ascending" }, 100, undefined, context);
  return page.items.filter((e) => e.kind === "maitred.watch").map((e) => (e.data as { text: string }).text);
}

test("a watch polls until the wanted date opens, then reports the match to the assistant", async () => {
  const state = { opened: [BOOKABLE_NOW.date] };
  const venue = await venueWith(state);
  const { m, modelSays } = await scripted();
  try {
    modelSays("Bookings just opened.");
    const started = await m.startWatch(specFor(venue), BOOKABLE_NOW);
    assert.ok("id" in started, JSON.stringify(started));
    await until(async () => ((await watchOf(m, started.id))?.probes ?? 0) >= 1, "the first probe");

    state.opened.push(WANTED.date);
    await until(async () => (await watchOf(m, started.id))?.state === "matched", "the match");

    assert.deepEqual((await watchOf(m, started.id))?.matches, [{ date: "2026-11-29", time: "19:00" }]);
    await until(async () => (await reports(m)).length === 1, "the report");
    const [report] = await reports(m);
    assert.match(report, /^Watch matched: Table for 2 at the test venue/);
    assert.match(report, /Bookings are open: https:\/\/venue\.example\/book/);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("a match hands the assistant back the note it wrote for that moment", async () => {
  const state = { opened: [BOOKABLE_NOW.date] };
  const venue = await venueWith(state);
  const { m, modelSays } = await scripted();
  try {
    modelSays("Booking it now.");
    const started = await m.startWatch(specFor(venue, { then: "Book 7 to 9 PM for 2 under Asha." }), BOOKABLE_NOW);
    assert.ok("id" in started, JSON.stringify(started));
    state.opened.push(WANTED.date);
    await until(async () => (await reports(m)).length === 1, "the report");
    assert.match((await reports(m))[0], /\nYour note for this moment: Book 7 to 9 PM for 2 under Asha\.$/);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("a watch does not start when its rule finds nothing even for a date that is bookable now", async () => {
  const venue = await venueWith({ opened: [BOOKABLE_NOW.date] });
  const { m } = await scripted();
  try {
    const wrongEndpoint = specFor(venue, {
      rule: `const page = await tools.get("${venue.url}/grid?day=" + input.params.date);
return page.data ? page.data : [];`,
    });
    const started = await m.startWatch(wrongEndpoint, BOOKABLE_NOW);
    assert.ok("refusal" in started);
    assert.match(started.refusal, /it has not been shown to detect availability/);
    assert.deepEqual(await watches(m), []);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("a watch does not start with neither proof nor a reason for having none", async () => {
  const venue = await venueWith({ opened: [] });
  const { m } = await scripted();
  try {
    const started = await m.startWatch(specFor(venue));
    assert.ok("refusal" in started);
    assert.match(started.refusal, /proof is missing/);
    assert.equal(venue.requests.length, 0);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("a watch with no possible proof starts marked unproven", async () => {
  const venue = await venueWith({ opened: [] });
  const { m } = await scripted();
  try {
    const started = await m.startWatch(specFor(venue, { unproven: "Every date is closed until Tuesday's release." }));
    assert.ok("id" in started, JSON.stringify(started));
    assert.equal((await watchOf(m, started.id))?.unproven, "Every date is closed until Tuesday's release.");
  } finally {
    await m.close();
    await venue.close();
  }
});

test("a watch does not start when its rule fails", async () => {
  const venue = await venueWith({ opened: [], broken: true });
  const { m } = await scripted();
  try {
    const started = await m.startWatch(specFor(venue), BOOKABLE_NOW);
    assert.ok("refusal" in started);
    assert.match(started.refusal, /The rule failed on the proof params/);
    assert.deepEqual(await watches(m), []);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("a watch does not start when it would poll more often than every 4 seconds", async () => {
  const venue = await venueWith({ opened: [BOOKABLE_NOW.date] });
  const { m } = await scripted();
  try {
    const started = await m.startWatch(specFor(venue, { intervalSeconds: 1 }), BOOKABLE_NOW);
    assert.ok("refusal" in started);
    assert.match(started.refusal, /intervalSeconds must be at least 4/);
    assert.equal(venue.requests.length, 0);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("a watch does not start when the wanted date is already open", async () => {
  const venue = await venueWith({ opened: [BOOKABLE_NOW.date, WANTED.date] });
  const { m } = await scripted();
  try {
    const started = await m.startWatch(specFor(venue), BOOKABLE_NOW);
    assert.ok("refusal" in started);
    assert.match(started.refusal, /already matches/);
    assert.match(started.refusal, /2026-11-29/);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("a stopped watch ends as stopped and stops polling", async () => {
  const venue = await venueWith({ opened: [BOOKABLE_NOW.date] });
  const { m } = await scripted();
  try {
    const started = await m.startWatch(specFor(venue), BOOKABLE_NOW);
    assert.ok("id" in started);
    await until(async () => ((await watchOf(m, started.id))?.probes ?? 0) >= 1, "the first probe");
    await m.stopWatch(started.id);
    assert.equal((await watchOf(m, started.id))?.state, "stopped");
    const seen = venue.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 4500));
    assert.equal(venue.requests.length, seen);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("a watch past its deadline ends and tells the assistant", async () => {
  const venue = await venueWith({ opened: [BOOKABLE_NOW.date] });
  const { m, modelSays } = await scripted();
  try {
    modelSays("It never opened.");
    const started = await m.startWatch(specFor(venue, { until: Date.now() + 1500 }), BOOKABLE_NOW);
    assert.ok("id" in started);
    await until(async () => (await watchOf(m, started.id))?.state === "expired", "the deadline");
    await until(async () => (await reports(m)).length === 1, "the report");
    assert.match((await reports(m))[0], /^Watch ended at its deadline without a match/);
  } finally {
    await m.close();
    await venue.close();
  }
});

test("a rule that starts failing is reported once and the watch keeps polling", async () => {
  const state = { opened: [BOOKABLE_NOW.date], broken: false };
  const venue = await venueWith(state);
  const { m, modelSays } = await scripted();
  try {
    modelSays("The site changed; I will look into it.");
    const started = await m.startWatch(specFor(venue), BOOKABLE_NOW);
    assert.ok("id" in started);
    await until(async () => ((await watchOf(m, started.id))?.probes ?? 0) >= 1, "the first probe");

    state.broken = true;
    await until(async () => (await reports(m)).length === 1, "the failure report", 30_000);
    assert.match((await reports(m))[0], /has failed 3 probes in a row/);

    await until(async () => ((await watchOf(m, started.id))?.probes ?? 0) >= 6, "more probes after the report", 30_000);
    assert.equal((await watchOf(m, started.id))?.state, "watching");
    assert.equal((await reports(m)).length, 1);
  } finally {
    await m.close();
    await venue.close();
  }
});
