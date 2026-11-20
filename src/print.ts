// Live console output for the task graph + watch requests. The daemon
// replaces this with the Telegram bridge (same doc reads, different sink).

import type { MaitredHarness } from "./harness.ts";
import { Requests, Watches } from "./docs.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

export async function watchTaskGraph(m: MaitredHarness, focused?: number) {
  const context = BACKGROUND_CONTEXT;
  const graph = await m.harness.watchTaskGraph(context);
  let last = "";
  await graph.start(async (call) => {
    if (call.kind !== "value") return;
    const nodes = Object.values(call.value.tasks);
    const lines = nodes.map((n) => {
      const st =
        n.state.status === "waiting"
          ? `waiting on ${n.state.on.join(",")}`
          : n.state.status === "sleeping"
            ? `sleeping until ${new Date((n.state.until ?? 0)).toLocaleTimeString()}`
            : n.state.status;
      const mark = focused !== undefined && n.id === focused ? "  <== your watch" : "";
      return `${n.kind} ${n.id} ${st}${mark}`;
    });
    const requests = await m.harness.snapshot(Requests, context);
    const watches = await m.harness.snapshot(Watches, context);
    const wKeys = Object.keys(watches ?? {});
    const w = wKeys.length ? watches?.[wKeys[0]] : undefined;
    const reqKeys = Object.keys(requests ?? {});
    const r = reqKeys.length ? requests?.[reqKeys[0]] : undefined;
    const summary =
      r
        ? `request: ${r.restaurant} ${r.dates.join(",")} @${r.times.join("/")} -> ${r.status} (${r.statusNote ?? ""})`
        : "";
    const probeInfo = w
      ? `| probes: ${w.probes} last: ${new Date(w.lastProbedAt ?? 0).toLocaleTimeString()} :: ${w.lastStatus ?? ""}`
      : "";
    const text = `${summary}\n${probeInfo}\n${lines.join("\n")}`;
    if (text !== last) {
      last = text;
      console.log(`\n[maitred ${new Date().toLocaleTimeString()}]\n${text}`);
    }
  });
}
