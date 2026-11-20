import { defineDoc } from "@earendil-works/pi-durable";

// NOTE: type aliases (not interfaces) — pi-durable docs require JsonObject
// (assignable-to-JsonValue) shapes, which interfaces don't satisfy.

// A booking request. Keyed by request id; updated by tasks.
export type RequestState = {
  restaurant: string;
  pax: number;
  // acceptable dates, ISO yyyy-mm-dd
  dates: string[];
  // acceptable times, HH:mm; empty = all bookable slots
  times: string[];
  status:
    | "accepted"
    | "discovering"
    | "watching"
    | "confirming"
    | "booked"
    | "failed"
    | "cancelled";
  statusNote?: string;
  recipeName?: string;
  bookingId?: string;
  taskId?: string;
  reconConversationId?: number; // discovery: recon agent conversation id
  createdAt?: number;
};

export type RequestsDoc = { [key: string]: RequestState };

export const Requests = defineDoc<RequestsDoc>({
  kind: "maitred.requests",
  version: 1,
  scope: "session",
  checkpointWhen: () => true,
  initial: () => ({}),
});

// Learned recipes mirror (also on disk in ./recipes). Keyed by canonical name.
export type RecipeRecord = {
  platform: string;
  recipeFile: string;
  knownSince: number;
};

export type RecipesDoc = { [key: string]: RecipeRecord };

export const Recipes = defineDoc<RecipesDoc>({
  kind: "maitred.recipes",
  version: 1,
  scope: "session",
  checkpointWhen: () => true,
  initial: () => ({}),
});

// Per-watch bookkeeping. Keyed by task id.
export type WatchState = {
  lastProbedAt?: number;
  lastStatus?: string;
  probes: number;
  flipsSeen: number;
};

export type WatchesDoc = { [key: string]: WatchState };

export const Watches = defineDoc<WatchesDoc>({
  kind: "maitred.watches",
  version: 1,
  scope: "session",
  checkpointWhen: () => true,
  initial: () => ({}),
});
