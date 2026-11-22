import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ToolResultEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Maitred } from "../src/harness.ts";
import { WatchList } from "../src/watch.ts";
import { scripted, site, tempDir, until } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

async function toolResults(m: Maitred): Promise<string[]> {
  const page = await m.root.entries({ order: "ascending" }, 100, undefined, context);
  return page.items.filter((e) => ToolResultEntry.is(e)).map((e) => JSON.stringify(e.model));
}

test("a message reaches the model with the person's local time, and the answer comes back", async () => {
  const { m, modelSays } = await scripted();
  try {
    modelSays("Which day would you like?");
    const answer = await m.answerOf(await m.say("table for 2 at guerilla diner"));
    assert.deepEqual(answer, { ok: true, text: "Which day would you like?" });

    const page = await m.root.entries({ order: "ascending" }, 10, undefined, context);
    const placed = page.items.find((e) => e.kind === "maitred.user");
    assert.deepEqual(placed?.data, { text: "table for 2 at guerilla diner" });
    assert.match(JSON.stringify(placed?.model), /\[\w{3},? \d{2} \w{3} \d{4},? \d{2}:\d{2} Asia\/Kolkata\]\\ntable for 2/);
  } finally {
    await m.close();
  }
});

test("the model saves a recipe through its tool", async () => {
  const { m, modelCalls, modelSays } = await scripted();
  try {
    modelCalls("recipes", {
      action: "write",
      name: "book-a-table-at-the-test-venue",
      content: "Book a table at the test venue\n\nVerified 2026-11-21: bookings via /slots.",
    });
    modelSays("Saved.");
    assert.deepEqual(await m.answerOf(await m.say("remember that")), { ok: true, text: "Saved." });
    assert.deepEqual(await m.recipes.list(), [
      { name: "book-a-table-at-the-test-venue", action: "Book a table at the test venue" },
    ]);
  } finally {
    await m.close();
  }
});

// A booking page that shows a 19:00 button when its day is open, and "No tables" otherwise.
const DAY_PAGE = `<!doctype html><title>loading</title><h1>Test Venue</h1><div id="out"></div>
<script>
  fetch("/api?day=" + new URLSearchParams(location.search).get("day")).then((r) => r.json()).then((day) => {
    document.getElementById("out").innerHTML = day.open ? "<button>19:00</button>" : "<p>No tables</p>";
    document.title = "ready";
  });
</script>`;

const DAY_RULE = `if (input.params.pax !== 2) throw new Error("params arrived as " + typeof input.params);
if (input.page.title !== "ready") throw new Error("the page did not finish loading");
return input.page.controls.filter((c) => c.name === "19:00").map((c) => ({ time: c.name }));`;

function dayVenue(isOpen: (day: string) => boolean) {
  return site((req) => {
    const url = new URL(req.path, "http://venue");
    return url.pathname === "/api" ? { json: { open: isOpen(url.searchParams.get("day") ?? "") } } : { html: DAY_PAGE };
  });
}

test("a watch starts when the model sends its params and proof as JSON strings", async () => {
  const venue = await dayVenue((day) => day === "proof");
  const { m, modelCalls, modelSays } = await scripted();
  try {
    modelCalls("watch", {
      action: "start",
      label: "Table for 2 at the test venue",
      steps: [{ action: "open", url: `${venue.url}/book?day={day}` }],
      rule: DAY_RULE,
      params: '{ "pax": 2, "day": "wanted" }',
      proof: '{ "pax": 2, "day": "proof" }',
      timezone: "Asia/Kolkata",
      intervalSeconds: 300,
      alert: "Bookings are open.",
    });
    modelSays("Watching.");
    assert.equal((await m.answerOf(await m.say("watch the test venue"))).ok, true);
    const watches = Object.values((await m.harness.snapshot(WatchList, context))?.items ?? {});
    assert.equal(watches.length, 1, (await toolResults(m)).join("\n"));
  } finally {
    await m.close();
    await venue.close();
  }
});

test("a watch the model starts through its tool survives a restart and still reports its match", async () => {
  let open = false;
  const venue = await dayVenue((day) => open || day === "proof");
  const dir = tempDir();
  const file = path.join(dir, "maitred.sqlite");

  const first = await scripted({ storage: await openNodeSqliteStorage(file), dir });
  first.modelCalls("watch", {
    action: "start",
    label: "Table for 2 at the test venue",
    steps: [{ action: "open", url: `${venue.url}/book?day={day}` }],
    rule: DAY_RULE,
    params: { pax: 2, day: "wanted" },
    proof: { pax: 2, day: "proof" },
    timezone: "Asia/Kolkata",
    intervalSeconds: 60,
    alert: "Bookings are open.",
  });
  first.modelSays("Watching.");
  let id: string;
  try {
    assert.deepEqual(await first.m.answerOf(await first.m.say("watch the test venue")), { ok: true, text: "Watching." });
    const before = Object.entries((await first.m.harness.snapshot(WatchList, context))?.items ?? {});
    assert.equal(before.length, 1, (await toolResults(first.m)).join("\n"));
    [id] = before[0];
    await until(
      async () => ((await first.m.harness.snapshot(WatchList, context))?.items[id]?.probes ?? 0) >= 1,
      "the first probe",
    );
  } finally {
    await first.m.close();
  }

  const second = await scripted({ storage: await openNodeSqliteStorage(file), dir });
  try {
    second.modelSays("It opened.");
    open = true;
    await until(
      async () => (await second.m.harness.snapshot(WatchList, context))?.items[id]?.state === "matched",
      "the match after the restart",
      80_000,
    );
  } finally {
    await second.m.close();
    await venue.close();
  }
});
