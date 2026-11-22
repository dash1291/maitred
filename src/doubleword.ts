import { createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { envApiKeyAuth } from "@earendil-works/pi-ai";
import type { Provider, Model } from "@earendil-works/pi-ai";

// Doubleword: OpenAI-compatible inference for open-weight models. An alternative to the Anthropic provider,
// selected with MAITRED_MODEL_PROVIDER=doubleword.

const DOUBLEWORD_BASE = "https://api.doubleword.ai/v1";

const MODEL_DEFS: Model<"openai-completions">[] = [
  {
    type: "chat",
    id: "deepseek-ai/DeepSeek-V4.1-Flash",
    name: "DeepSeek V4.1 Flash (Doubleword)",
    provider: "doubleword",
    baseUrl: DOUBLEWORD_BASE,
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 8192,
    // Rates are not known here, so reported cost is zero for this provider.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    type: "chat",
    id: "zai-org/GLM-5.3",
    name: "GLM-5.3 (Doubleword)",
    provider: "doubleword",
    baseUrl: DOUBLEWORD_BASE,
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
];

export function doublewordProvider(): Provider {
  return createProvider({
    id: "doubleword",
    name: "Doubleword",
    baseUrl: DOUBLEWORD_BASE,
    auth: { apiKey: envApiKeyAuth("Doubleword API key", ["DOUBLEWORD_API_KEY"]) },
    models: MODEL_DEFS,
    api: openAICompletionsApi(),
  });
}
