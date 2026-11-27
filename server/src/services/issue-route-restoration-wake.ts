import { activityLog, issues, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { buildExecutionStageWakeContext, parseIssueExecutionState } from "./issue-execution-policy.js";

export const ISSUE_ROUTE_RESTORED = "issue.execution_policy_restored";
export const ISSUE_ROUTE_RESTORATION_WAKE = "issue_execution_policy_restored";

// JSONB supplies stable key ordering; the digest keeps audit redaction out of admission.
export const issueRouteFingerprint = sql<string>`encode(sha256(convert_to(
  jsonb_build_array(${issues.executionPolicy}, ${issues.executionState})::text, 'UTF8'
)), 'hex')`;

/** Admission calls this while it owns the issue row. Policy-only edits may
 * leave statusVersion unchanged, so build context only from the audited route. */
export async function readRestoredRouteWakeContext(db: Db, input: {
  companyId: string; issueId: string; restorationActivityId: string;
}) {
  const [match] = await db.select({ executionState: issues.executionState }).from(activityLog)
    .innerJoin(issues, and(eq(issues.companyId, activityLog.companyId),
      sql`${issues.id}::text = ${activityLog.entityId}`))
    .where(and(eq(activityLog.companyId, input.companyId), eq(issues.id, input.issueId),
      eq(activityLog.id, input.restorationActivityId), eq(activityLog.entityType, "issue"),
      eq(activityLog.action, ISSUE_ROUTE_RESTORED),
      sql`${issueRouteFingerprint} = ${activityLog.details}->>'routeFingerprint'`,
    )).limit(1);
  const state = parseIssueExecutionState(match?.executionState);
  return state?.status === "pending" ? buildExecutionStageWakeContext(state) : null;
}
