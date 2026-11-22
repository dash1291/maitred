import assert from "node:assert/strict";
import { test } from "node:test";
import { listedHosts } from "../src/http.ts";
import { runRule } from "../src/rule.ts";
import { anyHost, site } from "./helpers.ts";

const input = { params: { pax: 2 }, today: "2026-11-21", now: 0 };

test("a rule fetches JSON and returns its matches", async () => {
  const venue = await site(() => ({ json: { slots: [{ time: "19:00", left: 4 }, { time: "20:00", left: 1 }] } }));
  const outcome = await runRule(
    `const page = await tools.get("${venue.url}/slots");
     return page.slots.filter((s) => s.left >= input.params.pax).map((s) => ({ date: input.today, time: s.time }));`,
    input,
    anyHost,
  );
  await venue.close();
  assert.deepEqual(outcome, { ok: true, matches: [{ date: "2026-11-21", time: "19:00" }] });
});

test("an empty array means nothing is available", async () => {
  assert.deepEqual(await runRule("return [];", input, anyHost), { ok: true, matches: [] });
});

test("a rule that throws is an error, not a match", async () => {
  const outcome = await runRule("return undefinedThing.slots;", input, anyHost);
  assert.equal(outcome.ok, false);
});

test("a rule must return an array", async () => {
  assert.deepEqual(await runRule("return true;", input, anyHost), {
    ok: false,
    error: "the rule must return an array of matches",
  });
});

test("a rule that never finishes is stopped at its timeout", async () => {
  const outcome = await runRule("while (true) {}", input, anyHost, { timeoutMs: 300 });
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /^timeout/);
});

test("a rule cannot fetch from a host the watch did not list", async () => {
  const venue = await site(() => ({ json: {} }));
  const outcome = await runRule(`return [await tools.get("${venue.url}/")];`, input, listedHosts(["example.com"], anyHost));
  await venue.close();
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /not one of this watch's hosts/);
  assert.equal(venue.requests.length, 0);
});

test("a non-2xx response fails the rule", async () => {
  const venue = await site(() => ({ status: 500, text: "boom" }));
  const outcome = await runRule(`return [await tools.get("${venue.url}/")];`, input, anyHost);
  await venue.close();
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /HTTP 500/);
});

test("a rule has no network, process or module access of its own", async () => {
  const outcome = await runRule("return [typeof fetch, typeof process, typeof require];", input, anyHost);
  assert.deepEqual(outcome, { ok: true, matches: ["undefined", "undefined", "undefined"] });
});
