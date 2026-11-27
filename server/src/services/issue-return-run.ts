import { eq } from "drizzle-orm";
import { heartbeatRuns, type Db, type issues } from "@paperclipai/db";
import { assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { TERMINAL_HEARTBEAT_RUN_STATUSES } from "./issues.js";

/** The calling transaction holds the issue lock through the handoff commit. */
export async function assertIssueReturnRunOwner(
  tx: Pick<Db, "select">,
  issue: typeof issues.$inferSelect,
  actor: { agentId: string; runId: string },
  runNotOwner: () => Error,
) {
  if ((issue.executionRunId ?? issue.checkoutRunId) !== actor.runId) {
    throw runNotOwner();
  }
  // Queue admission can bind the new execution before replacing an ended checkout.
  if (issue.checkoutRunId && issue.checkoutRunId !== actor.runId) {
    const [checkout] = await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, issue.checkoutRunId)).for("share");
    if (checkout && !TERMINAL_HEARTBEAT_RUN_STATUSES.has(checkout.status)) throw runNotOwner();
  }
  const run = await assertAgentRunWriteAllowed(tx, issue.companyId, actor);
  // Coalesced wakes can replace the context. Use the admitted task binding
  // when one exists and fall back to the context for older legacy runs.
  const runIssueId = run?.nativeIssueId ?? run?.issueId ?? run?.contextSnapshot?.issueId ?? run?.contextSnapshot?.taskId;
  if (run?.status !== "running" || runIssueId !== issue.id) {
    throw runNotOwner();
  }
}
