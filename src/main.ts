// maitred CLI entry. Phase 1: local test drive — start a Guerilla watch,
// print the durable polling loop, verify crash-resume by restarting the
// process against the same SQLite state.

import { bootstrap, startWatch } from "./harness.ts";
import { fetchRestaurant } from "./connectors/airmenus.ts";
import { watchTaskGraph } from "./print.ts";

const args = process.argv.slice(2);
const command = args[0] ?? "watch";

async function nextWeekend(): Promise<string[]> {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < 14; i++) {
    const day = d.getDay();
    if (day === 5 || day === 6 || day === 0) out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return [...new Set(out)];
}

async function main() {
  const m = await bootstrap();
  console.log(`[maitred] harness open, resume()d`);

  if (command === "watch") {
    const restaurant = args[1] ?? "guerilladiner";
    const rest = await fetchRestaurant(restaurant);
    const outletId = rest.outlets[0]!.id;
    console.log(`[maitred] ${rest.name}: outlet ${outletId}`);

    const dates = await nextWeekend();
    const giveUp = Date.now() + 6 * 60 * 60 * 1000; // 6h from now
    const id = await startWatch(m, {
      requestId: `req-${Date.now()}`,
      outletId,
      dates,
      times: ["19:00", "20:00"],
      pollSeconds: 4,
      giveUpAt: giveUp,
    });
    console.log(`[maitred] watch task ${String(id)} started; ctrl-c / kill -9 to test resume`);

    void watchTaskGraph(m, Number(id));
  }
}

main().catch((e) => {
  console.error("[maitred] fatal:", e);
  process.exit(1);
});
