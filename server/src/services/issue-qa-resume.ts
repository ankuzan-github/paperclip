import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issueExecutionDecisions, issueThreadInteractions, type Db, type issues } from "@paperclipai/db";
import { askUserQuestionsResultSchema, issueExecutionPolicySchema, resumeIssueExecutionStageSchema } from "@paperclipai/shared";
import type { z } from "zod";
import { assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { conflict, forbidden } from "../errors.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { TERMINAL_HEARTBEAT_RUN_STATUSES } from "./issues.js";

export type ResumeIssueExecutionStage = z.infer<typeof resumeIssueExecutionStageSchema>;

const CARDS_CEO_ID = "9cadde33-aa45-4828-b66e-e99cb4d33212";
const CARDS_QA_APPROVAL_PATTERN = "^verified: [0-9a-f]{40}";
const HISTORICAL_QA_RESUME = {
  identifier: "LEA-1880",
  returnDecisionId: "ec1c4b0c-4bb0-4a7c-a6b4-927678af5d47",
  ceoInteractionId: "baad9173-8028-4e97-810e-75eb2daa5db9",
};

export function issueQaResumeSnapshotChanged() {
  return conflict("The saved QA return changed. Read the task again before resuming QA.", {
    code: "issue_qa_resume_snapshot_changed",
  });
}

/** Called with the issue row locked in the transaction that writes the transition. */
export async function prepareIssueQaResume(
  tx: Pick<Db, "select">,
  issue: typeof issues.$inferSelect,
  request: ResumeIssueExecutionStage,
  actor: { agentId: string; runId: string },
) {
  if (issue.statusVersion !== request.statusVersion || issue.updatedAt.getTime() !== Date.parse(request.updatedAt)) {
    throw issueQaResumeSnapshotChanged();
  }
  if (issue.assigneeAgentId !== actor.agentId || issue.assigneeUserId !== null) {
    throw forbidden("Only the current assignee can resume QA");
  }

  const runNotOwner = () => conflict("Only the running task owner can resume QA", { code: "issue_qa_resume_run_not_owner" });
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

  const state = parseIssueExecutionState(issue.executionState);
  const policy = issueExecutionPolicySchema.safeParse(issue.executionPolicy);
  const stage = policy.success ? policy.data.stages[state?.currentStageIndex ?? -1] : undefined;
  const participant = state?.currentParticipant;
  if (!issue.identifier || !/^LEA-\d+$/.test(issue.identifier) || !["todo", "in_progress", "blocked"].includes(issue.status) ||
    !state || state.status !== "changes_requested" || state.lastDecisionOutcome !== "changes_requested" ||
    state.currentStageId !== request.stageId || state.lastDecisionId !== request.returnDecisionId ||
    state.currentStageType !== "review" || state.completedStageIds.includes(request.stageId) ||
    state.returnAssignee?.type !== "agent" || state.returnAssignee.agentId !== actor.agentId ||
    stage?.id !== request.stageId || stage.type !== "review" || stage.approvalCommentPattern !== CARDS_QA_APPROVAL_PATTERN ||
    participant?.type !== "agent" || !participant.agentId || participant.agentId === actor.agentId ||
    !stage.participants.some((candidate) => candidate.type === "agent" && candidate.agentId === participant.agentId)) {
    throw issueQaResumeSnapshotChanged();
  }

  const [decision] = await tx.select({ id: issueExecutionDecisions.id, createdAt: issueExecutionDecisions.createdAt })
    .from(issueExecutionDecisions).where(and(
      eq(issueExecutionDecisions.id, request.returnDecisionId),
      eq(issueExecutionDecisions.companyId, issue.companyId),
      eq(issueExecutionDecisions.issueId, issue.id),
      eq(issueExecutionDecisions.stageId, request.stageId),
      eq(issueExecutionDecisions.stageType, "review"),
      eq(issueExecutionDecisions.outcome, "changes_requested"),
      eq(issueExecutionDecisions.actorAgentId, participant.agentId),
    )).for("share");
  if (!decision) throw issueQaResumeSnapshotChanged();

  const [interaction] = await tx.select({
    result: issueThreadInteractions.result,
    createdAt: issueThreadInteractions.createdAt,
    resolvedAt: issueThreadInteractions.resolvedAt,
  }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, request.ceoInteractionId),
    eq(issueThreadInteractions.companyId, issue.companyId),
    eq(issueThreadInteractions.issueId, issue.id),
    eq(issueThreadInteractions.kind, "ask_user_questions"),
    eq(issueThreadInteractions.status, "answered"),
    eq(issueThreadInteractions.resolvedByAgentId, CARDS_CEO_ID),
  )).for("share");
  const result = askUserQuestionsResultSchema.safeParse(interaction?.result);
  const isHistoricalDecision = issue.identifier === HISTORICAL_QA_RESUME.identifier &&
    decision.id === HISTORICAL_QA_RESUME.returnDecisionId &&
    request.ceoInteractionId === HISTORICAL_QA_RESUME.ceoInteractionId;
  const marker = `pc-resume-qa: ${issue.identifier} return=${decision.id}`;
  if (!interaction?.resolvedAt || interaction.createdAt < decision.createdAt || interaction.resolvedAt < interaction.createdAt ||
    !result.success || result.data.outcome || result.data.cancelled ||
    !result.data.answers.some(({ questionId, otherText }) =>
      questionId === "restore_route" && otherText &&
      (isHistoricalDecision || otherText.split(/\r?\n/, 1)[0]?.trim() === marker))) {
    throw forbidden("A confirmed CEO response for this QA return is required", {
      code: "issue_qa_resume_ceo_response_required",
    });
  }

  return {
    status: "in_review",
    assigneeAgentId: participant.agentId,
    assigneeUserId: null,
    executionState: { ...issue.executionState, status: "pending" },
  };
}
