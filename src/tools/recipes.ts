import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineTool, section } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";

const NAME = /^[a-z0-9][a-z0-9-]{1,79}$/;

export type RecipeStore = {
  list(): Promise<{ name: string; action: string }[]>;
  read(name: string): Promise<string | null>;
  write(name: string, content: string): Promise<void>;
};

/**
 * Recipes are markdown files, one per action that has been done. `writable` shadows `builtin` (the ones shipped in
 * git), so a recipe the assistant rewrites wins over the shipped copy and survives redeploys.
 */
export function createRecipeStore(dirs: { writable: string; builtin: string }): RecipeStore {
  const fileIn = (dir: string, name: string) => {
    if (!NAME.test(name)) throw new Error(`recipe name must match ${NAME}: lowercase letters, digits and hyphens`);
    return path.join(dir, `${name}.md`);
  };
  const tryRead = (file: string) => readFile(file, "utf8").catch(() => null);
  const namesIn = async (dir: string) =>
    (await readdir(dir).catch(() => [] as string[]))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .filter((n) => NAME.test(n));

  const read = async (name: string) =>
    (await tryRead(fileIn(dirs.writable, name))) ?? (await tryRead(fileIn(dirs.builtin, name)));

  return {
    read,
    async list() {
      const names = [...new Set([...(await namesIn(dirs.writable)), ...(await namesIn(dirs.builtin))])].sort();
      const out: { name: string; action: string }[] = [];
      for (const name of names) {
        const text = (await read(name)) ?? "";
        const first = text.split("\n").find((line) => line.trim()) ?? "";
        out.push({ name, action: first.replace(/^#+\s*/, "").trim() });
      }
      return out;
    },
    async write(name, content) {
      const file = fileIn(dirs.writable, name);
      await mkdir(dirs.writable, { recursive: true });
      await writeFile(file, content.endsWith("\n") ? content : `${content}\n`);
    },
  };
}

function renderIndex(items: { name: string; action: string }[]): string {
  if (items.length === 0) return "No recipes yet.";
  return items.map((r) => `${r.name}: ${r.action}`).join("\n");
}

const FULL_TEXT_CHARS = 24_000;

/**
 * What the assistant always has in front of it. While the recipes are few they are shown in full, so one that applies
 * cannot be overlooked; past the budget only the index is shown and each has to be read with the tool.
 */
export function createRecipesSection(store: RecipeStore) {
  return section("recipes", async () => {
    const items = await store.list();
    if (items.length === 0) return "No recipes yet.";
    const full = (await Promise.all(items.map(async (r) => `=== ${r.name} ===\n${(await store.read(r.name)) ?? ""}`))).join("\n\n");
    if (full.length <= FULL_TEXT_CHARS) return full;
    return `${renderIndex(items)}\n\nThese are only the first lines. Read a recipe in full with the recipes tool before acting on it.`;
  });
}

export function createRecipesTool(store: RecipeStore) {
  return defineTool({
    name: "recipes",
    description:
      "Your record of actions that have been done, one markdown recipe per action. " +
      "list: names with the action each records. read: one recipe in full. " +
      "write: create or replace a recipe; its first line is the action in plain words " +
      '(for example "Book a table at Guerilla Diner, Bangalore").',
    parameters: obj({
      action: oneOf(["list", "read", "write"]),
      name: opt(str({ description: "Recipe name: lowercase letters, digits and hyphens. For read and write." })),
      content: opt(str({ description: "Full markdown of the recipe. For write." })),
    }),
    execute: async (args) => {
      const text = (value: string, isError = false) => ({ output: [{ type: "text" as const, text: value }], isError });
      if (args.action === "list") return text(renderIndex(await store.list()));
      if (!args.name) return text("name is required", true);
      if (args.action === "read") {
        const content = await store.read(args.name);
        return content === null ? text(`no recipe named ${args.name}`, true) : text(content);
      }
      if (!args.content?.trim()) return text("content is required", true);
      await store.write(args.name, args.content);
      return text(`saved recipe ${args.name}`);
    },
  });
}
