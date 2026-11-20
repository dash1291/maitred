// Offline test for the LLM intake parser.
//   node --experimental-strip-types scripts/parse-test.ts "<message>"
// Needs ANTHROPIC_API_KEY (or DOUBLEWORD_API_KEY +
// MAITRED_MODEL_PROVIDER=doubleword).
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { parseRequestLlm } from "../src/parse.ts";

const msg = process.argv[2] ?? 'book a seat for 2 at guerilla diner';
const provider = process.env.MAITRED_MODEL_PROVIDER === "doubleword" && process.env.DOUBLEWORD_API_KEY
  ? "doubleword"
  : process.env.ANTHROPIC_API_KEY ? "anthropic" : undefined;
if (!provider) {
  console.error("no model provider configured (ANTHROPIC_API_KEY or DOUBLEWORD_API_KEY)");
  process.exit(1);
}
const models = createModels();
const { doublewordProvider } = await import("../src/doubleword.ts");
models.setProvider(provider === "doubleword" ? doublewordProvider() : anthropicProvider());
const parsed = await parseRequestLlm(models, provider, msg);
console.log(parsed ? JSON.stringify(parsed, null, 1) : "PARSE FAILED");
process.exit(0);
