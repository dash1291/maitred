import type { Context } from "@earendil-works/chord/context";
import { defineDoc, defineSignal, type ToolExecutionApi, type ToolPark } from "@earendil-works/pi-durable";
import { bool, obj } from "@earendil-works/pi-schema";

/** The person's answer to one pending approval, delivered to the parked tool call's task under `DECISION`. */
export const Approval = defineSignal({ name: "maitred.approval", version: 1, schema: obj({ allow: bool() }) });
export const DECISION = "decision";

/** What the person is shown: the question, and exactly what would be sent or typed. */
export type PendingApproval = { question: string; detail: string; askedAt: number };

export type PendingDoc = { items: { [taskId: string]: PendingApproval } };

export const PendingApprovals = defineDoc<PendingDoc>({
  kind: "maitred.pending-approvals",
  version: 1,
  scope: "session",
  initial: () => ({ items: {} }),
  checkpointWhen: () => true,
});

/** Text the person has agreed may be typed on a site without asking each time: their own details, per hostname. */
export type TypingAllowancesDoc = { sites: { [hostname: string]: { label: string; text: string }[] } };

export const TypingAllowances = defineDoc<TypingAllowancesDoc>({
  kind: "maitred.typing-allowances",
  version: 1,
  scope: "session",
  initial: () => ({ sites: {} }),
  checkpointWhen: () => true,
});

const APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000;

export type Decided = { allowed: true } | { allowed: false; why: string };
export type Question = { question: string; detail: string };
/** Tells the person, wherever they are, that an approval is waiting. */
export type Announce = (approvalId: string, ask: Question) => Promise<void>;

/**
 * Ask the person, once per tool call. The first run records the question and returns a park for the tool to return;
 * the run after they answer (or after a day) returns their decision.
 */
export async function askPerson(
  api: ToolExecutionApi,
  context: Context,
  ask: Question,
  announce?: Announce,
): Promise<{ park: ToolPark } | Decided> {
  const id = String(api.taskId);
  const decision = await api.readSignal(Approval, DECISION, context);
  if (decision === undefined) {
    await api.commit(async (tx) => {
      (await tx.doc(PendingApprovals)).items[id] = { ...ask, askedAt: api.now() };
    }, context);
    await announce?.(id, ask);
    return { park: { sleep: { signals: [Approval.key(DECISION)], until: api.now() + APPROVAL_WINDOW_MS } } };
  }
  await withdrawQuestion(api, context);
  if ("expired" in decision) return { allowed: false, why: "nobody answered within a day" };
  return decision.value.allow ? { allowed: true } : { allowed: false, why: "the person declined" };
}

export async function withdrawQuestion(api: ToolExecutionApi, context: Context): Promise<void> {
  await api.commit(async (tx) => {
    delete (await tx.doc(PendingApprovals)).items[String(api.taskId)];
  }, context);
}
