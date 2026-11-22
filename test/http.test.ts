import assert from "node:assert/strict";
import { test } from "node:test";
import { httpGet, listedHosts, publicHost } from "../src/http.ts";
import { anyHost, site } from "./helpers.ts";

test("a loopback address is not a public host", async () => {
  const local = await site(() => ({ text: "secret" }));
  await assert.rejects(httpGet(local.url, { allow: publicHost }), /not a public host/);
  await local.close();
  assert.equal(local.requests.length, 0);
});

test("a name that resolves to loopback is not a public host", async () => {
  await assert.rejects(httpGet("http://localhost:9/", { allow: publicHost }), /not a public host/);
});

test("a redirect to a host outside the list is not followed", async () => {
  const other = await site(() => ({ text: "elsewhere" }), "localhost");
  const venue = await site(() => ({ location: `${other.url}/` }));
  await assert.rejects(
    httpGet(venue.url, { allow: listedHosts(["127.0.0.1"], anyHost) }),
    /localhost is not one of this watch's hosts/,
  );
  await venue.close();
  await other.close();
  assert.equal(other.requests.length, 0);
});

test("a redirect within the allowed hosts is followed", async () => {
  const venue = await site((req) => (req.path === "/" ? { location: "/there" } : { text: "arrived" }));
  const res = await httpGet(venue.url, { allow: anyHost });
  await venue.close();
  assert.equal(res.body, "arrived");
  assert.equal(res.url, `${venue.url}/there`);
});

test("a body larger than the limit is cut and marked truncated", async () => {
  const venue = await site(() => ({ text: "x".repeat(5000) }));
  const res = await httpGet(venue.url, { allow: anyHost, maxBytes: 1000 });
  await venue.close();
  assert.equal(res.body.length, 1000);
  assert.equal(res.truncated, true);
});
