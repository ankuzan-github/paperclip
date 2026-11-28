import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { activityLog, agents, issueExecutionDecisions, issueThreadInteractions, type Db, type issues } from "@paperclipai/db";
import { askUserQuestionsResultSchema, issueExecutionPolicySchema, resubmitIssueExecutionReviewSchema, type IssueExecutionDecision } from "@paperclipai/shared";
import type { z } from "zod";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { isHeartbeatWakeOnDemandEnabled } from "./heartbeat-policy.js";
import { applyIssueMonitorPolicyTransition, normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";
import { assertIssueReturnRunOwner } from "./issue-return-run.js";

export type ResubmitIssueExecutionReview = z.infer<typeof resubmitIssueExecutionReviewSchema>;

const CARDS_COMPANY_ID = "bf0903fa-e62e-4dd2-b19b-5cacaa541460";
const CARDS_PROJECT_ID = "8fd59ee4-3ccf-44c2-b149-5d678ce5b985";
const CARDS_CEO_ID = "9cadde33-aa45-4828-b66e-e99cb4d33212";
const PRODUCT_DESIGNER_ID = "f7094a71-a3c4-421d-877a-e1480058da0f";
// The CEO's product-ui requirement for LEA-2039 survives changes to its old policy.
const FULL_RESUBMISSION_ISSUE_ID = "f329e062-013a-40e6-843a-91490c8515b8";
const RETURN_CEILING = 3;
const REVIEW_PATTERN = "^reviewed: [0-9a-f]{40}";
const DELIVERY_PATTERN = "^delivery: from=[0-9a-f]{40} to=[0-9a-f]{40} reviewed=[0-9a-f]{40}";
const QA_PATTERN = "^verified: [0-9a-f]{40}";
const FULL_QA_PATTERN = "^verified: [0-9a-f]{40} depth=full$";
const DESIGN_PATTERN = "^design-control: qa/design-control/LEA-\\d+\\.md соответствует";
const LIGHT_DESIGN_PATTERN = "^(?:" + DESIGN_PATTERN.slice(1) + "|design: unchanged [0-9a-f]{40})";
const HISTORICAL = {
  issueId: "fcc11975-dfac-4d12-8b49-6f90182b3462",
  identifier: "LEA-2049",
  returnDecisionId: "af456ebd-4a00-4a1c-9eb3-2499ca84c79c",
  ceoInteractionId: "15bc20b1-b677-494d-ab4a-e4dff86f53fb",
  sha: "395d90eb3a4afc6aee4339cf03df13962ce51354",
};
const HISTORICAL_APPROVAL = `Разрешаю один повторный проход LEA-2049 для опубликованного SHA ${HISTORICAL.sha} после возврата ${HISTORICAL.returnDecisionId}. Маршрут — review (Architect) → delivery → QA. Архитектор проверяет весь сдаваемый SHA и отдельно регрессии LEA-2095, LEA-2096 и LEA-2097. Доставка начинается после его одобрения, затем проходит QA.`;

export const ISSUE_REVIEW_RESUBMISSION_CONSUMED = "issue.review_resubmission_consumed";

export async function assertResubmittedReviewApproval(
  db: Pick<Db, "select">,
  issue: Pick<typeof issues.$inferSelect, "id" | "companyId">,
  decision: Pick<IssueExecutionDecision, "stageId" | "outcome" | "body"> | undefined,
) {
  if (issue.companyId !== CARDS_COMPANY_ID || decision?.outcome !== "approved") return;
  const receipts = await db.select({
    sha: sql<string | null>`${activityLog.details}->>'reviewedSha'`,
  }).from(activityLog).where(and(
    eq(activityLog.companyId, issue.companyId),
    eq(activityLog.entityType, "issue"),
    eq(activityLog.entityId, issue.id),
    eq(activityLog.actorType, "system"),
    eq(activityLog.action, ISSUE_REVIEW_RESUBMISSION_CONSUMED),
    sql`${activityLog.details}->>'reviewStageId' = ${decision.stageId}::text`,
  )).limit(2);
  if (receipts.length === 0) return;

  // Delivery reads the first reviewed SHA. A matching line later in the
  // evidence must never authorize a different first SHA.
  const sha = receipts[0]?.sha;
  if (receipts.length !== 1 || !sha || !/^[0-9a-f]{40}$/.test(sha) ||
    decision.body.split(/\r?\n/, 1)[0] !== `reviewed: ${sha}`) {
    throw unprocessable("The first approval line must identify the SHA authorized for this review stage", {
      code: "issue_review_resubmission_approval_sha_mismatch",
      reviewedSha: receipts.length === 1 ? sha : undefined,
    });
  }
}

export function issueReviewResubmissionSnapshotChanged() {
  return conflict("The saved review return changed. Read the task again before resubmitting.", {
    code: "issue_review_resubmission_snapshot_changed",
  });
}

/** Validate the decision and source state while holding the issue row for the transition. */
export async function prepareIssueReviewResubmission(
  tx: Pick<Db, "select">,
  issue: typeof issues.$inferSelect,
  request: ResubmitIssueExecutionReview,
  actor: { agentId: string; runId: string },
) {
  const { stageId, returnDecisionId, ceoInteractionId, reviewedSha, route } = request;
  const identifier = issue.identifier;
  if (issue.companyId !== CARDS_COMPANY_ID || issue.projectId !== CARDS_PROJECT_ID ||
    !identifier || !/^LEA-\d+$/.test(identifier)) {
    throw forbidden("This resubmission route is scoped to the Cards project");
  }
  if (issue.statusVersion !== request.statusVersion || issue.updatedAt.getTime() !== Date.parse(request.updatedAt)) {
    throw issueReviewResubmissionSnapshotChanged();
  }
  if (issue.assigneeAgentId !== actor.agentId || issue.assigneeUserId !== null) {
    throw forbidden("Only the current Fullstack assignee can resubmit");
  }
  await assertIssueReturnRunOwner(tx, issue, actor, () =>
    conflict("Only the running task owner can resubmit", { code: "issue_review_resubmission_run_not_owner" }),
  );

  const state = parseIssueExecutionState(issue.executionState);
  const policy = issueExecutionPolicySchema.safeParse(issue.executionPolicy);
  const stage = policy.success ? policy.data.stages[state?.currentStageIndex ?? -1] : undefined;
  const participant = state?.currentParticipant;
  if (!["todo", "in_progress", "blocked"].includes(issue.status) ||
    state?.status !== "changes_requested" || state.lastDecisionOutcome !== "changes_requested" ||
    state.currentStageId !== stageId || state.lastDecisionId !== returnDecisionId ||
    state.completedStageIds.includes(stageId) ||
    state.returnAssignee?.type !== "agent" || state.returnAssignee.agentId !== actor.agentId ||
    stage?.id !== stageId || stage.type !== state.currentStageType || !["review", "delivery"].includes(stage.type) ||
    participant?.type !== "agent" || !participant.agentId ||
    !stage.participants.some((candidate) => candidate.type === "agent" && candidate.agentId === participant.agentId)) {
    throw issueReviewResubmissionSnapshotChanged();
  }

  const decisionScope = and(
    eq(issueExecutionDecisions.companyId, issue.companyId),
    eq(issueExecutionDecisions.issueId, issue.id),
  );
  const [latest] = await tx.select({
    id: issueExecutionDecisions.id,
    outcome: issueExecutionDecisions.outcome,
    stageId: issueExecutionDecisions.stageId,
    stageType: issueExecutionDecisions.stageType,
    actorAgentId: issueExecutionDecisions.actorAgentId,
    createdAt: issueExecutionDecisions.createdAt,
  }).from(issueExecutionDecisions).where(decisionScope)
    .orderBy(desc(issueExecutionDecisions.createdAt), desc(issueExecutionDecisions.id)).limit(1).for("share");
  if (latest?.id !== returnDecisionId || latest.outcome !== "changes_requested" || latest.stageId !== stageId ||
    latest.stageType !== stage.type || latest.actorAgentId !== participant.agentId) {
    throw issueReviewResubmissionSnapshotChanged();
  }
  const returns = await tx.select({ id: issueExecutionDecisions.id }).from(issueExecutionDecisions)
    .where(and(decisionScope, eq(issueExecutionDecisions.outcome, "changes_requested")))
    .limit(RETURN_CEILING).for("share");
  if (returns.length < RETURN_CEILING) {
    throw conflict("The return ceiling has not been reached", { code: "issue_review_resubmission_below_ceiling" });
  }

  const requiresDesign = issue.id === FULL_RESUBMISSION_ISSUE_ID || policy.data?.stages.some((candidate) =>
    candidate.approvalCommentPattern === DESIGN_PATTERN || candidate.approvalCommentPattern === LIGHT_DESIGN_PATTERN ||
    candidate.participants.some((member) => member.type === "agent" && member.agentId === PRODUCT_DESIGNER_ID),
  );
  const expectedRoute = requiresDesign ? "product-ui" : "product";
  if (route !== expectedRoute) {
    throw unprocessable("The resubmission route must match the required Cards route", {
      code: "issue_review_resubmission_route_mismatch",
      expectedRoute,
    });
  }

  const [interaction] = await tx.select({
    result: issueThreadInteractions.result,
    idempotencyKey: issueThreadInteractions.idempotencyKey,
    createdAt: issueThreadInteractions.createdAt,
    resolvedAt: issueThreadInteractions.resolvedAt,
  }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, ceoInteractionId),
    eq(issueThreadInteractions.companyId, issue.companyId),
    eq(issueThreadInteractions.issueId, issue.id),
    eq(issueThreadInteractions.kind, "ask_user_questions"),
    eq(issueThreadInteractions.status, "answered"),
    eq(issueThreadInteractions.resolvedByAgentId, CARDS_CEO_ID),
  )).for("share");
  const result = askUserQuestionsResultSchema.safeParse(interaction?.result);
  const answers = result.success ? result.data.answers.filter(({ questionId }) => questionId === "next_route") : [];
  const answer = answers.length === 1 ? answers[0]?.otherText : null;
  const marker = `pc-resubmit-review: ${identifier} return=${returnDecisionId} sha=${reviewedSha}`;
  const authorized = ceoInteractionId === HISTORICAL.ceoInteractionId
    ? route === "product" && issue.id === HISTORICAL.issueId && identifier === HISTORICAL.identifier &&
      returnDecisionId === HISTORICAL.returnDecisionId && reviewedSha === HISTORICAL.sha &&
      interaction?.idempotencyKey === `review-ceiling:${issue.id}:${returnDecisionId}:${reviewedSha}` &&
      answer?.split("\n\n", 1)[0] === HISTORICAL_APPROVAL
    : answer?.trim() === `${marker} route=${route}` || (route === "product" && answer?.trim() === marker);
  if (!interaction?.resolvedAt || interaction.createdAt < latest.createdAt || interaction.resolvedAt < interaction.createdAt ||
    !result.success || result.data.outcome || result.data.cancelled ||
    !authorized) {
    throw forbidden("A confirmed CEO response for this issue, return, SHA and route is required", {
      code: "issue_review_resubmission_ceo_response_required",
    });
  }
  if (request.comment.split("\n", 1)[0] !== `submitted: ${reviewedSha} branch=pc/${identifier}`) {
    throw unprocessable("The first comment line must identify the authorized SHA and task branch", {
      code: "issue_review_resubmission_comment_mismatch",
    });
  }

  // A receipt is written by the system so permanent deletion of the submitting
  // agent and its attributed activity cannot restore the authority to resubmit.
  const [consumed] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.companyId, issue.companyId),
    eq(activityLog.entityType, "issue"),
    eq(activityLog.entityId, issue.id),
    eq(activityLog.actorType, "system"),
    eq(activityLog.action, ISSUE_REVIEW_RESUBMISSION_CONSUMED),
    sql`${activityLog.details}->>'ceoInteractionId' = ${ceoInteractionId}::text`,
  )).limit(1);
  if (consumed) {
    throw conflict("The CEO response has already been used", { code: "issue_review_resubmission_already_used" });
  }

  const routeAgents = await tx.select({
    id: agents.id, role: agents.role, name: agents.name, runtimeConfig: agents.runtimeConfig,
  }).from(agents).where(and(
    eq(agents.companyId, issue.companyId),
    inArray(agents.status, ["active", "idle", "running", "error"]),
    or(
      eq(agents.role, "qa"),
      and(eq(agents.role, "engineer"), ilike(agents.name, "%architect%")),
      and(eq(agents.role, "engineer"), eq(agents.id, actor.agentId), ilike(agents.name, "%fullstack%")),
      route === "product-ui" ? and(eq(agents.role, "designer"), eq(agents.id, PRODUCT_DESIGNER_ID)) : undefined,
    ),
  )).for("share");
  const fullstack = routeAgents.find((agent) => agent.id === actor.agentId && agent.role === "engineer" &&
    agent.name.toLowerCase().includes("fullstack"));
  if (!fullstack) throw forbidden("Only an active Cards Fullstack agent can resubmit");
  const architects = routeAgents.filter((agent) => agent.id !== fullstack.id && agent.role === "engineer");
  const qaAgents = routeAgents.filter((agent) => agent.role === "qa");
  const [architect] = architects;
  const [qa] = qaAgents;
  if (architects.length !== 1 || qaAgents.length !== 1 || !architect || !qa ||
    !isHeartbeatWakeOnDemandEnabled(architect)) {
    throw conflict("The Cards review route requires one available Architect and QA agent", {
      code: "issue_review_resubmission_route_unavailable",
    });
  }
  const designer = routeAgents.find((agent) => agent.id === PRODUCT_DESIGNER_ID && agent.role === "designer");
  if (route === "product-ui" && !designer) {
    throw conflict("The Cards product-ui route requires the available Product Designer", {
      code: "issue_review_resubmission_route_unavailable",
    });
  }

  const principal = (agentId: string) => ({ type: "agent" as const, agentId, userId: null });
  const makeStage = (type: "review" | "delivery", agentId: string, approvalCommentPattern: string) => ({
    type, participants: [principal(agentId)], approvalCommentPattern,
  });
  const previousPolicy = normalizeIssueExecutionPolicy(issue.executionPolicy);
  const executionPolicy = normalizeIssueExecutionPolicy({
    ...previousPolicy,
    mode: "normal",
    monitor: null,
    stages: [
      makeStage("review", architect.id, REVIEW_PATTERN),
      makeStage("delivery", fullstack.id, DELIVERY_PATTERN),
      makeStage("review", qa.id, requiresDesign ? FULL_QA_PATTERN : QA_PATTERN),
      ...(designer ? [makeStage("review", designer.id, DESIGN_PATTERN)] : []),
    ],
  })!;
  const monitor = applyIssueMonitorPolicyTransition({
    issue,
    previousPolicy,
    policy: executionPolicy,
    requestedStatus: "in_review",
    requestedAssigneePatch: { assigneeAgentId: architect.id, assigneeUserId: null },
    actor,
    monitorExplicitlyUpdated: true,
  }).patch;
  return {
    ...monitor,
    status: "in_review",
    assigneeAgentId: architect.id,
    assigneeUserId: null,
    executionPolicy,
    executionState: {
      status: "pending",
      currentStageId: executionPolicy.stages[0]!.id,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: principal(architect.id),
      returnAssignee: principal(fullstack.id),
      completedStageIds: [],
      lastDecisionId: returnDecisionId,
      lastDecisionOutcome: "changes_requested",
      reviewRequest: null,
      monitor: null,
      changesRequestedCount: 0,
    },
  };
}
