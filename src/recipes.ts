import { readFile } from "node:fs/promises";
import path from "node:path";

export interface Recipe {
  restaurant: string;
  platform: string;
  recipeFile: string;
  recon?: Record<string, unknown>;
  probe?: { poll_seconds?: number } & Record<string, unknown>;
  book?: Record<string, unknown>;
  fallback?: Record<string, unknown>;
  [k: string]: unknown;
}

const RECIPE_DIR = path.resolve(process.cwd(), "recipes");

export async function loadRecipe(
  canonicalName: string,
): Promise<Recipe | null> {
  try {
    const file = path.join(RECIPE_DIR, `${canonicalName}.json`);
    return JSON.parse(await readFile(file, "utf8")) as Recipe;
  } catch {
    return null;
  }
}

// Canonicalize a user-spoken restaurant name into a recipe key:
// "Guerilla Diner" / "guerilla" -> "guerilladiner.json" if present.
// Strategy: exact file, then fuzzy: strip spaces/punct and suffix-match files.
export async function findRecipe(
  spoken: string,
): Promise<Recipe | null> {
  const norm = spoken.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!norm) return null;
  const direct = await loadRecipe(norm);
  if (direct) return direct;
  // fuzzy: score = longest suffix overlap with candidate files
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(RECIPE_DIR)).filter((f) => f.endsWith(".json"));
  let best: { score: number; file: string } | null = null;
  for (const f of files) {
    const stem = f.replace(/\.json$/, "").toLowerCase();
    if (norm.includes(stem) || stem.includes(norm)) {
      const score = Math.min(stem.length, norm.length);
      if (!best || score > best.score) best = { score, file: stem };
    }
  }
  return best ? loadRecipe(best.file) : null;
}
