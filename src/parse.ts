// Intake parser: message in, structured request out. The LLM does the
// natural-language part (it's one cheap call per message, not per poll);
// date math and defaults stay deterministic in the fallback below.

import type { Models } from "@earendil-works/pi-ai/models";

export interface ParsedRequest {
  restaurantName: string;
  city: string;
  dates: string[]; // yyyy-mm-dd, ascending, max ~4
  times: string[]; // HH:mm, empty = any time of day
  pax: number;
  // Canonical recipe name if the spoken restaurant matches a known recipe
  // from the provided list (LLM's call — the caller only guards against
  // hallucinated names). null = no match.
  matchedRecipe?: string | null;
}

// Provider-appropriate default parse models. Overridable via
// MAITRED_PARSE_MODEL; must match a model id in that provider's catalog.
export function parseModelFor(provider: string): string {
  if (process.env.MAITRED_PARSE_MODEL) return process.env.MAITRED_PARSE_MODEL;
  switch (provider) {
    case "doubleword":
      return "deepseek-ai/DeepSeek-V4.1-Flash";
    case "anthropic":
    default:
      return "claude-haiku-4-5";
  }
}

const SYSTEM = (today: string, known: string[]) =>
  `You extract booking-request parameters from a message for a restaurant
reservation assistant in India, and route the restaurant. Today is ${today} (UTC).

Return ONLY a JSON object, no prose, no code fences:
{"restaurantName": string, "matchedRecipe": string|null, "city": string, "dates": string[], "times": string[], "pax": number}

Rules:
- restaurantName: the restaurant's name as diners call it (may be partial); "" if the message has none.
- matchedRecipe: if the restaurant in the message is clearly the same place
  as one of these known recipes, its exact key; else null:
${known.length ? known.map((k) => `  - ${k}`).join("\n") : "  (no known recipes — always null)"}
  Partial or casual references ("guerilla", a nickname) still match when
  the referent is unambiguous; when in doubt, null.
- city: default "Bangalore".
- dates: resolve relative words ("this saturday", "tomorrow", "the weekend")
  and absolute dates ("5th dec") to ISO dates in yyyy-mm-dd form, ascending,
  at most 4. Empty if the message implies "as soon as possible".
- times: HH:mm 24h form; explicitly given times exactly; when the message
  implies dinner but gives no time, use ["19:00","19:30","20:00","20:30"];
  lunch implies ["12:30","13:00"]; empty if any time is fine.
- pax: the number of people, default 2.
- Never invent a restaurant or a matchedRecipe key.`;

export async function parseRequestLlm(
  models: Models,
  provider: string,
  message: string,
  knownRecipes: string[] = [],
): Promise<ParsedRequest | null> {
  const model = models.getModel(provider, parseModelFor(provider));
  if (!model) return null;
  const today = new Date().toISOString().slice(0, 10);
  let result;
  try {
    result = await models.completeSimple(model, {
      systemPrompt: SYSTEM(today, knownRecipes),
      messages: [
        {
          role: "user",
          content: message,
          timestamp: Date.now(),
        },
      ],
    });
  } catch {
    return null;
  }
  const text =
    typeof result.content === "string"
      ? result.content
      : result.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[0]) as Partial<ParsedRequest>;
    const dates = (raw.dates ?? [])
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)))
      .sort()
      .slice(0, 4);
    const times = (raw.times ?? [])
      .map((t) => String(t))
      .filter((t) => /^\d{2}:\d{2}$/.test(t))
      .slice(0, 8);
    const pax = Math.max(1, Math.min(12, Number(raw.pax) || 2));
    const name = String(raw.restaurantName ?? "").trim().slice(0, 80);
    if (!name) return null;
    // Guard, not logic: accept the model's match only if it names a recipe
    // we actually have (the model decides WHICH name; this just prevents
    // hallucinated keys from reaching the store).
    const matched =
      typeof raw.matchedRecipe === "string" && knownRecipes.includes(raw.matchedRecipe)
        ? raw.matchedRecipe
        : null;
    return {
      restaurantName: name,
      matchedRecipe: matched,
      city: String(raw.city ?? "Bangalore").trim() || "Bangalore",
      dates,
      times,
      pax,
    };
  } catch {
    return null;
  }
}
