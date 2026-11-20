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

// List canonical recipe names, published tier first (a published recipe
// shadows the builtin of the same stem). This is directory listing — the
// LLM decides which one a message refers art; no fuzzy matching here.
export async function listRecipeNames(): Promise<string[]> {
  const published = await readdir(PUBLISHED_DIR).catch(() => [] as string[]);
  const builtin = await readdir(BUILTIN_DIR).catch(() => [] as string[]);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const f of [...published, ...builtin]) {
    if (!f.endsWith(".json")) continue;
    const stem = f.replace(/\.json$/, "");
    if (seen.has(stem)) continue;
    seen.add(stem);
    names.push(stem);
  }
  return names;
}
