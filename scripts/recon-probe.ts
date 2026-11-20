// Probe: does the recon agent config actually give a model its tools?
// Creates a throwaway conversation with the same agent change and asks it
// to run one bash command. Run with MAITRED_MODEL_PROVIDER=doubleword.
import { bootstrap } from "../src/harness.ts";
import { reconAgentChange, scratchDirFor } from "../src/agents/recon.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { mkdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";

const m = await bootstrap();
const scratch = mkdtempSync("/tmp/recon-probe-");
const conv = await m.harness.createConversation(
  {
    ownership: { kind: "conversation" } as never,
    agent: reconAgentChange(scratch, { provider: m.modelProvider!, modelId: "zai-org/GLM-5.3" }),
  },
  BACKGROUND_CONTEXT,
);
await conv.submit(
  {
    type: "input",
    content:
      "This is a connectivity probe. Use the bash tool to run exactly: echo PROBE-$((40+2))  — then report the tool output verbatim, then output the recipe JSON as your instructions require (any valid skeleton is fine for this probe).",
  } as never,
  BACKGROUND_CONTEXT,
);
console.log("submitted — watch for the settled entry in state/maitred.sqlite (conversation", conv.id + ")");
setTimeout(() => process.exit(0), 120_000);
