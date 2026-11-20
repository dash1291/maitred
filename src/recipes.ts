// Recipe store, two tiers:
//   1. state/recipes/  — runtime-published recipes (survives redeploys; the
//      container bind-mounts ./state)
//   2. recipes/        — built-in recipes shipped with the image (git)
// Discovery publishes to tier 1. A written recipe always shadows the built-in
// of the same name, so updating a recipe never needs a code change.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseRecipe, type Recipe } from "./recipe-schema.ts";

const BUILTIN_DIR = path.resolve(process.cwd(), "recipes");
const PUBLISHED_DIR = path.resolve(process.cwd(), "state", "recipes");

export type { Recipe };

export const RECIPE_DIR_PATH = PUBLISHED_DIR;

async function tryLoad(dir: string, stem: string): Promise<Recipe | null> {
  try {
    return parseRecipe(await readFile(path.join(dir, `${stem}.json`), "utf8"));
  } catch {
    return null;
  }
}

export async function loadRecipe(canonicalName: string): Promise<Recipe | null> {
  return (
    (await tryLoad(PUBLISHED_DIR, canonicalName)) ??
    (await tryLoad(BUILTIN_DIR, canonicalName))
  );
}

// Canonicalize a user-spoken restaurant name into a recipe key:
// "Guerilla Diner" / "guerilla" -> "guerilladiner.json" if present.
// Strategy: exact slug, then fuzzy include-match against files (published
// recipes take precedence over built-ins of the same stem).
export async function findRecipe(spoken: string): Promise<Recipe | null> {
  const norm = spoken.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!norm) return null;
  const direct = await loadRecipe(norm);
  if (direct) return direct;
  const published = await readdir(PUBLISHED_DIR).catch(() => [] as string[]);
  const builtin = await readdir(BUILTIN_DIR).catch(() => [] as string[]);
  const stems = [
    ...published.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")),
    ...builtin.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")),
  ];
  let best: { score: number; stem: string } | null = null;
  for (const stem of stems) {
    const low = stem.toLowerCase();
    // Compare purely alphanumeric forms: stems contain dashes, spoken
    // names don't ("guerilladiner" ~ "guerilla-diner").
    const alnum = low.replace(/[^a-z0-9]/g, "");
    if (alnum && (norm.includes(alnum) || alnum.includes(norm))) {
      const score = Math.min(alnum.length, norm.length);
      if (!best || score > best.score) best = { score, stem };
    }
  }
  return best ? loadRecipe(best.stem) : null;
}

// Slug a display name into a canonical recipe name. "Loya, Bengaluru" ->
// "loya". Removes city names and generic words.
export function slugify(name: string): string {
  const STOP = [
    "bangalore", "bengaluru", "blr", "mumbai", "delhi", "newdelhi", "ncr",
    "restaurant", "cafe", "kitchen", "the", "and", "table", "for", "at",
  ];
  const parts = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.includes(w));
  return parts.join("-").replace(/^-+|-+$/g, "").slice(0, 60) || "restaurant";
}
