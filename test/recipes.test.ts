import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRecipesSection, createRecipeStore } from "../src/tools/recipes.ts";
import { tempDir } from "./helpers.ts";

function store() {
  const dir = tempDir();
  const dirs = { writable: path.join(dir, "state"), builtin: path.join(dir, "builtin") };
  mkdirSync(dirs.builtin, { recursive: true });
  return { dirs, recipes: createRecipeStore(dirs) };
}

test("a written recipe reads back and is listed by its first line", async () => {
  const { recipes } = store();
  await recipes.write("book-a-table-at-guerilla-diner", "# Book a table at Guerilla Diner, Bangalore\n\nUses AirMenus.");
  assert.match((await recipes.read("book-a-table-at-guerilla-diner")) ?? "", /Uses AirMenus/);
  assert.deepEqual(await recipes.list(), [
    { name: "book-a-table-at-guerilla-diner", action: "Book a table at Guerilla Diner, Bangalore" },
  ]);
});

test("a recipe shipped with the code is listed and readable", async () => {
  const { dirs, recipes } = store();
  writeFileSync(path.join(dirs.builtin, "order-a-kebab.md"), "Order a kebab from X on Zomato\n");
  assert.deepEqual(await recipes.list(), [{ name: "order-a-kebab", action: "Order a kebab from X on Zomato" }]);
});

test("a rewritten recipe wins over the shipped one of the same name", async () => {
  const { dirs, recipes } = store();
  writeFileSync(path.join(dirs.builtin, "order-a-kebab.md"), "Order a kebab, as shipped\n");
  await recipes.write("order-a-kebab", "Order a kebab, as learned later");
  assert.equal(await recipes.read("order-a-kebab"), "Order a kebab, as learned later\n");
  assert.equal((await recipes.list()).length, 1);
});

test("a missing recipe reads as null", async () => {
  assert.equal(await store().recipes.read("nothing-here"), null);
});

test("a name cannot reach outside the recipes directory", async () => {
  const { recipes } = store();
  await assert.rejects(recipes.write("../escape", "x"), /recipe name must match/);
  await assert.rejects(recipes.read("../../etc/passwd"), /recipe name must match/);
});

test("the assistant is shown its recipes in full while they are few", async () => {
  const { recipes } = store();
  await recipes.write("book-a-table", "Book a table at the test venue\n\nOpen the link with the date in it.");
  const shown = await createRecipesSection(recipes).render({} as never, BACKGROUND_CONTEXT);
  assert.match(shown ?? "", /=== book-a-table ===\nBook a table at the test venue\n\nOpen the link with the date in it\./);
});

test("once the recipes outgrow the prompt, the assistant is shown only their first lines", async () => {
  const { recipes } = store();
  await recipes.write("book-a-table", "Book a table at the test venue\n\n" + "A long account. ".repeat(2000));
  const shown = (await createRecipesSection(recipes).render({} as never, BACKGROUND_CONTEXT)) ?? "";
  assert.match(shown, /^book-a-table: Book a table at the test venue\n/);
  assert.doesNotMatch(shown, /A long account/);
  assert.match(shown, /Read a recipe in full with the recipes tool/);
});
