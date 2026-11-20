// Recipe schema v1 — the durable artifact discovery produces and watches
// consume. Hand-rolled validators (pi-schema would be fine too; this keeps
// the shape in one place with good error messages).

export interface RecipeIds {
  [key: string]: string | number | boolean;
}

export interface RecipeProbe {
  kind: "days-config";
  intervalSeconds: number; // >= connector floor
}

export interface RecipeRestaurant {
  displayName: string;
  city: string;
  website?: string;
  bookingPage?: string;
  platformId: string; // "airmenus" | ... | "generic-http"(later)
  fingerprintedFrom?: string; // URL hint that matched
  ids: RecipeIds;
}

export interface RecipeValidation {
  probeOk: boolean;
  slotsEnumerated: number;
  checkedAt: string; // ISO
  courtesyFloor: number; // connector floor it must respect
}

export interface Recipe {
  name: string; // canonical slug
  version: 1;
  restaurant: RecipeRestaurant;
  probe: RecipeProbe;
  validation?: RecipeValidation;
  createdAt: string;
  discoveredBy: "manual" | "discovery";
}

export class RecipeError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super("invalid recipe: " + issues.join("; "));
    this.issues = issues;
  }
}

function isPosInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

export function validateRecipe(r: unknown): asserts r is Recipe {
  const issues: string[] = [];
  const o = r as Partial<Recipe>;

  if (typeof o.name !== "string" || !/^[a-z0-9-]{2,60}$/.test(o.name ?? "")) {
    issues.push("name must be a lowercase slug (a-z0-9-, 2-60 chars)");
  }
  if (o.version !== 1) issues.push("version must be 1");
  const res = o.restaurant;
  if (!res || typeof res.displayName !== "string") issues.push("restaurant.displayName required");
  if (!res || typeof res.city !== "string") issues.push("restaurant.city required");
  if (!res || typeof res?.platformId !== "string") issues.push("restaurant.platformId required");
  if (res && typeof res.ids !== "object") issues.push("restaurant.ids must be an object");

  const probe = o.probe;
  if (!probe || probe?.kind !== "days-config") {
    issues.push('probe.kind must be "days-config" for v1');
  }
  if (!probe || !isPosInt(probe?.intervalSeconds)) {
    issues.push("probe.intervalSeconds must be a positive integer");
  }
  if (typeof o.createdAt !== "string") issues.push("createdAt (ISO string) required");

  if (issues.length > 0) throw new RecipeError(issues);
}

export function parseRecipe(jsonText: string): Recipe {
  const obj = JSON.parse(jsonText);
  validateRecipe(obj);
  return obj;
}

// Airmenus recipes need shortName outletId for the connector. Encoded here so
// discovery knows what the platform demands, not hard-coded in the task.
export const PLATFORM_REQUIRES: Record<string, { ids: string[]; probeKind: BeefProbeKind }> = {
  airmenus: { ids: ["shortName", "outletId"], probeKind: "days-config" },
};

type BeefProbeKind = "days-config";

export function checkPlatformRequirements(recipe: Recipe): string[] {
  const req = PLATFORM_REQUIRES[recipe.restaurant.platformId];
  if (!req) return ["unknown platform: " + recipe.restaurant.platformId];
  const issues: string[] = [];
  for (const id of req.ids) {
    if (!(id in recipe.restaurant.ids)) issues.push(`platform ${recipe.restaurant.platformId} requires ids.${id}`);
  }
  if (recipe.probe.kind !== req.probeKind) {
    issues.push(`platform ${recipe.restaurant.platformId} probe must be ${req.probeKind}`);
  }
  return issues;
}
