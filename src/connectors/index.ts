// Platform registry: recipe.restaurant.platformId -> probe connector.
// v1 ships AirMenus (the reverse-engineered platform). New platforms add a
// probe method here; recipes stay data.

import {
  fetchRestaurant,
  fetchOutletConfig,
  dayStatus,
  type AirMenusConfig,
} from "./airmenus.ts";
import type { Recipe, RecipeValidation } from "../recipe-schema.ts";

export const COURTESY_FLOOR = 2; // connector floor, seconds

export interface Platform {
  id: string;
  /** Read-only replay of a recipe through the live platform. Never books. */
  validate(recipe: Recipe): Promise<
    | { ok: false; reason: string }
    | { ok: true; value: RecipeValidation }
  >;
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const AirMenusPlatform: Platform = {
  id: "airmenus",
  async validate(recipe) {
    const shortName = String(recipe.restaurant.ids.shortName ?? "");
    const outletId = Number(recipe.restaurant.ids.outletId ?? 0);
    if (!shortName || !outletId) {
      return { ok: false, reason: "ids.shortName / ids.outletId missing or malformed" };
    }
    let config: AirMenusConfig;
    try {
      // Recipe honesty check: does this shortName actually resolve?
      const rest = await fetchRestaurant(shortName);
      if (!rest.outlets.some((o) => o.id === outletId)) {
        return {
          ok: false,
          reason: `outletId ${outletId} not found for ${shortName} (found: ${rest.outlets.map((o) => o.id).join(", ") || "none"})`,
        };
      }
      config = await fetchOutletConfig(outletId);
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    // Enumerate slots across a week window (read-only).
    let slots = 0;
    for (const day of WEEKDAYS) {
      const st = dayStatus(config, day);
      if (!st.open) continue;
      for (const g of st.groups) slots += g.times.length;
    }
    if (recipe.probe.intervalSeconds < COURTESY_FLOOR) {
      return { ok: false, reason: `intervalSeconds ${recipe.probe.intervalSeconds} below floor ${COURTESY_FLOOR}` };
    }
    return {
      ok: true,
      value: {
        probeOk: true,
        slotsEnumerated: slots,
        checkedAt: new Date().toISOString(),
        courtesyFloor: COURTESY_FLOOR,
      },
    };
  },
};

const PLATFORMS: Record<string, Platform> = {
  airmenus: AirMenusPlatform,
};

export function platformFor(id: string): Platform | undefined {
  return PLATFORMS[id];
}
