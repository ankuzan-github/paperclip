import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, getTableColumns, gte, inArray, or, sql } from "drizzle-orm";
import {
  activityLog, agents, agentWakeupRequests, caseHandoffs, heartbeatRuns, issueExecutionDecisions,
  issueRecoveryActions, issueRelations, issues, type Db,
} from "@paperclipai/db";
import {
  isAgentInvokable, type IssueExecutionState, type IssueRouteRestorationRequest,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { issueService, wakeRequestTargetsIssue } from "./issues.js";
import { isHeartbeatWakeOnDemandEnabled } from "./heartbeat-policy.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import {
  assigneePrincipal, normalizeIssueExecutionPolicy, parseIssueExecutionState,
  stageHasParticipant, assertApprovalCommentMatchesStagePattern,
} from "./issue-execution-policy.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { notifyNativeStatusWakeWork } from "./deferred-execution-notifications.js";

import { ISSUE_ROUTE_RESTORED, ISSUE_ROUTE_RESTORATION_WAKE, issueRouteFingerprint } from "./issue-route-restoration-wake.js";

type Issue = typeof issues.$inferSelect;
type Activity = typeof activityLog.$inferSelect;
type Decision = typeof issueExecutionDecisions.$inferSelect;

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function invalidSource() {
  return conflict("Activity does not contain a recoverable route reset", { code: "route_restore_invalid_source" });
}

function policySnapshot(value: unknown) {
  try {
    return normalizeIssueExecutionPolicy(value);
  } catch {
    throw invalidSource();
  }
}

function isIdleRoute(state: IssueExecutionState) {
  return state.status === "idle" && state.currentStageId === null && state.currentStageIndex === null &&
    state.currentStageType === null && state.currentParticipant === null && state.returnAssignee === null &&
    state.completedStageIds.length === 0 && state.lastDecisionId === null && state.lastDecisionOutcome === null &&
    state.reviewRequest === null && state.changesRequestedCount === 0;
}

function readReset(source: Activity) {
  const previous = record(source.details?._previous);
  const changes = record(source.details?.changes);
  const policyChange = record(changes.executionPolicy);
  const stateChange = record(changes.executionState);
  if (!isDeepStrictEqual(policyChange.from, previous.executionPolicy) ||
      !isDeepStrictEqual(policyChange.to, source.details?.executionPolicy) ||
      !isDeepStrictEqual(stateChange.from, previous.executionState) ||
      !isDeepStrictEqual(stateChange.to, source.details?.executionState)) {
    throw invalidSource();
  }
  const policy = policySnapshot(previous.executionPolicy);
  const state = parseIssueExecutionState(previous.executionState);
  const resetPolicy = policySnapshot(source.details?.executionPolicy);
  const resetState = parseIssueExecutionState(source.details?.executionState);
  if (!policy || policy.monitor || !state || state.monitor || !resetPolicy?.monitor || resetPolicy.stages.length ||
      !resetState || !isIdleRoute(resetState) || resetState.monitor?.status !== "scheduled" ||
      resetState.monitor.nextCheckAt !== resetPolicy.monitor.nextCheckAt) {
    throw invalidSource();
  }
  const [review, delivery, qa, designer] = policy.stages;
  if (policy.mode !== "normal" || policy.stages.length !== 4 ||
      review?.type !== "review" || delivery?.type !== "delivery" ||
      qa?.type !== "review" || designer?.type !== "review" ||
      new Set(policy.stages.map(stage => stage.id)).size !== 4 ||
      policy.stages.some(stage => stage.participants.length !== 1 ||
        stage.participants[0].type !== "agent" || !stage.approvalCommentPattern) ||
      new Set(policy.stages.map(stage => stage.participants[0].id)).size !== 4 ||
      new Set(policy.stages.map(stage => stage.participants[0].agentId)).size !== 4 ||
      !isDeepStrictEqual(policy.stages, record(previous.executionPolicy).stages)) {
    throw invalidSource();
  }
  const qaAgentId = qa.participants[0].agentId!;
  const designerAgentId = designer.participants[0].agentId!;
  const fullstackAgentId = delivery.participants[0].agentId!;
  if (state.status !== "pending" || state.currentStageIndex !== 2 || state.currentStageId !== qa.id ||
      state.currentStageType !== qa.type || !stageHasParticipant(qa, state.currentParticipant) ||
      !stageHasParticipant(delivery, state.returnAssignee) || state.lastDecisionOutcome !== "approved" ||
      !isDeepStrictEqual(state.completedStageIds, [review.id, delivery.id]) ||
      previous.status !== "in_review" || previous.assigneeAgentId !== qaAgentId || previous.assigneeUserId != null ||
      source.details?.status !== "in_progress" ||
      source.details?.assigneeAgentId !== fullstackAgentId || source.details?.assigneeUserId != null) {
    throw invalidSource();
  }
  return { policy, state, review, delivery, qa, designer, qaAgentId, designerAgentId, fullstackAgentId };
}

function verifyDecisions(decisions: Decision[], source: Activity, reset: ReturnType<typeof readReset>) {
  const relevant = decisions.filter(decision => reset.state.completedStageIds.includes(decision.stageId));
  const [review, delivery] = relevant;
  if (relevant.length !== 2 || decisions.at(-2)?.id !== review.id || decisions.at(-1)?.id !== delivery.id ||
      delivery.createdAt >= source.createdAt ||
      review.stageId !== reset.review.id || delivery.stageId !== reset.delivery.id ||
      review.createdAt >= delivery.createdAt || delivery.id !== reset.state.lastDecisionId) {
    throw invalidSource();
  }
  for (const [decision, stage] of [[review, reset.review], [delivery, reset.delivery]] as const) {
    if (decision.stageType !== stage.type || decision.outcome !== "approved" ||
        decision.createdAt.getTime() !== decision.updatedAt.getTime() ||
        !decision.actorAgentId || decision.actorUserId ||
        !stageHasParticipant(stage, assigneePrincipal({
          assigneeAgentId: decision.actorAgentId, assigneeUserId: null,
        }))) {
      throw invalidSource();
    }
    try {
      assertApprovalCommentMatchesStagePattern(stage, decision.body);
    } catch {
      throw invalidSource();
    }
  }
  const reviewedSha = /^reviewed: ([a-f0-9]{40})(?=\s|$)/m.exec(review.body)?.[1];
  const deliveryReviewedSha = /^delivery: from=[a-f0-9]{40} to=[a-f0-9]{40} reviewed=([a-f0-9]{40})(?=\s|$)/m.exec(delivery.body)?.[1];
  if (!reviewedSha || reviewedSha !== deliveryReviewedSha) throw invalidSource();
  return [review.id, delivery.id];
}

function routeProjection(issue: Issue) {
  return {
    status: issue.status,
    statusVersion: issue.statusVersion,
    updatedAt: issue.updatedAt.toISOString(),
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
    executionPolicy: issue.executionPolicy,
    executionState: issue.executionState,
    unblockDescriptor: issue.unblockDescriptor,
    blockedTransitionAt: issue.blockedTransitionAt?.toISOString() ?? null,
    blockedOwnerNotifiedAt: issue.blockedOwnerNotifiedAt?.toISOString() ?? null,
  };
}

async function assertIssueIdle(tx: Db, issue: Issue) {
  const { companyId, id } = issue;
  const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId),
    inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
    or(eq(heartbeatRuns.issueId, id), eq(heartbeatRuns.nativeIssueId, id),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${id}`,
      sql`${heartbeatRuns.contextSnapshot}->>'taskId' = ${id}`),
  )).limit(1);
  const [wake] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId),
    inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
    wakeRequestTargetsIssue(id),
  )).limit(1);
  const [recovery] = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, id),
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
  )).limit(1);
  const [handoff] = await tx.select({ id: caseHandoffs.id }).from(caseHandoffs).where(and(
    eq(caseHandoffs.companyId, companyId), eq(caseHandoffs.issueId, id),
    inArray(caseHandoffs.state, ["awaiting_release", "pending_dispatch"]),
  )).limit(1);
  if (run || wake || recovery || handoff ||
      await getExecutionBlocker(tx, companyId, id) ||
      await issueTreeControlService(tx).getActivePauseHoldGate(companyId, id)) {
    throw conflict("Issue has active or pending execution work", { code: "route_restore_issue_busy" });
  }
}

async function restoreWakeIntent(tx: Db, input: {
  issue: Issue; sourceActivityId: string; auditActivityId: string; agentId: string;
}) {
  // The normal status-wake dispatcher owns admission. Queue its intent in the
  // same commit as the route so a restart or lost response cannot lose the wake.
  const [wake] = await tx.insert(agentWakeupRequests).values({
    companyId: input.issue.companyId,
    agentId: input.agentId,
    source: "assignment",
    triggerDetail: "system",
    reason: ISSUE_ROUTE_RESTORATION_WAKE,
    requestedByActorType: "system",
    requestedByActorId: "native-status-committer",
    idempotencyKey: `${ISSUE_ROUTE_RESTORATION_WAKE}:${input.issue.id}:${input.sourceActivityId}`,
    payload: {
      issueId: input.issue.id,
      restorationActivityId: input.auditActivityId,
      restoredStatusVersion: input.issue.statusVersion,
    },
  }).returning({ id: agentWakeupRequests.id });
  await notifyNativeStatusWakeWork(tx, { companyId: input.issue.companyId, requestId: wake.id });
  return wake.id;
}

export async function restoreIssueRoute(input: {
  db: Db;
  companyId: string;
  issueId: string;
  operatorId: string;
  request: IssueRouteRestorationRequest;
  authorize: (tx: Db, issue: Issue) => Promise<void>;
}) {
  const { db, companyId, issueId, request } = input;
  const result = await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [issue] = await tx.select().from(issues).where(and(
      eq(issues.companyId, companyId), eq(issues.id, issueId),
    )).for("update");
    if (!issue) throw notFound("Issue not found");
    await input.authorize(tx, issue);

    const scopedHistory = and(eq(activityLog.companyId, companyId),
      eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issueId));
    const [priorRestore] = await tx.select({ details: activityLog.details }).from(activityLog).where(and(
      scopedHistory, eq(activityLog.action, ISSUE_ROUTE_RESTORED),
      sql`${activityLog.details}->>'sourceActivityId' = ${request.activityId}`,
    )).limit(1);
    if (priorRestore) {
      const receipt = record(priorRestore.details?.receipt);
      if (!request.dryRun && priorRestore.details?.blockerIssueId === request.blockerIssueId &&
          isDeepStrictEqual(priorRestore.details?.expectedVersion, request.expectedVersion)) {
        return { response: receipt };
      }
      throw conflict("This route reset has already been restored", { code: "route_restore_already_applied" });
    }
    const expectedVersion = {
      statusVersion: issue.statusVersion,
      updatedAt: issue.updatedAt.toISOString(),
    };
    if (request.expectedVersion && !isDeepStrictEqual(request.expectedVersion, expectedVersion)) {
      throw conflict("Issue changed after the restoration preview", { code: "route_restore_stale_preview" });
    }
    if (issue.checkoutRunId || issue.executionRunId || issue.executionLockedAt || issue.executionAgentNameKey) {
      throw conflict("Issue has an execution owner", { code: "route_restore_issue_busy" });
    }

    const [source] = await tx.select().from(activityLog).where(and(
      scopedHistory, eq(activityLog.id, request.activityId), eq(activityLog.action, "issue.updated"),
    )).limit(1);
    if (!source) throw invalidSource();
    const reset = readReset(source);
    const currentState = parseIssueExecutionState(issue.executionState);
    if (issue.status !== "blocked" || issue.assigneeAgentId !== reset.fullstackAgentId || issue.assigneeUserId ||
        issue.conversationAgentId || issue.hiddenAt || issue.executionPolicy !== null ||
        !currentState || !isIdleRoute(currentState) ||
        currentState.monitor?.status !== "cleared" || !currentState.monitor.clearedAt ||
        new Date(currentState.monitor.clearedAt) < source.createdAt ||
        currentState.monitor.nextCheckAt || issue.monitorNextCheckAt || issue.monitorWakeRequestedAt) {
      throw conflict("Issue no longer matches the cleared route and monitor", { code: "route_restore_issue_changed" });
    }

    // A later route that was itself removed must still invalidate this snapshot.
    const later = await tx.select({ details: activityLog.details }).from(activityLog).where(and(
      scopedHistory, eq(activityLog.action, "issue.updated"), gte(activityLog.createdAt, source.createdAt),
      sql`${activityLog.id} <> ${source.id}`,
      sql`(${activityLog.details}->'changes' ? 'executionPolicy'
        OR ${activityLog.details} ? 'executionPolicy'
        OR ${activityLog.details}->'_previous' ? 'executionPolicy')`,
    ));
    if (later.some(({ details }) => {
      const change = record(record(details?.changes).executionPolicy);
      const previous = record(details?._previous);
      return [change.from, change.to, previous.executionPolicy, details?.executionPolicy]
        .some(value => value != null && (!Array.isArray(record(value).stages) ||
          (record(value).stages as unknown[]).length !== 0));
    })) {
      throw conflict("A later route replaced the reset policy", { code: "route_restore_issue_changed" });
    }

    const decisions = await tx.select().from(issueExecutionDecisions).where(and(
      eq(issueExecutionDecisions.companyId, companyId), eq(issueExecutionDecisions.issueId, issueId),
    )).orderBy(issueExecutionDecisions.createdAt);
    const decisionIds = verifyDecisions(decisions, source, reset);
    await assertIssueIdle(tx, issue);

    const companyAgents = await tx.select({
      id: agents.id, companyId: agents.companyId, name: agents.name,
      status: agents.status, reportsTo: agents.reportsTo,
      runtimeConfig: agents.runtimeConfig,
    }).from(agents).where(eq(agents.companyId, companyId));
    if ([reset.qaAgentId, reset.designerAgentId].some(id => {
      const agent = companyAgents.find(candidate => candidate.id === id);
      return !agent || !isAgentInvokable({ agent, agents: companyAgents }) || !isHeartbeatWakeOnDemandEnabled(agent);
    })) {
      throw conflict("QA or Product Designer cannot receive the restored route", { code: "route_restore_participant_unavailable" });
    }

    const scope = and(eq(issueRelations.companyId, companyId),
      eq(issueRelations.relatedIssueId, issueId), eq(issueRelations.type, "blocks"));
    // Readiness includes the normal workspace-finalization barrier on done blockers.
    const readiness = await issueService(tx).getDependencyReadiness(issueId, tx, { lockSources: true })
      .catch((error: unknown) => {
        if (record(error).code === "55P03" || record(record(error).cause).code === "55P03")
          throw conflict("Issue dependencies are being updated", { code: "route_restore_blockers_changed" });
        throw error;
      });
    const [dependency] = await tx.select({ edge: issueRelations }).from(issueRelations)
      .innerJoin(issues, and(eq(issues.id, issueRelations.issueId), eq(issues.companyId, companyId)))
      .where(and(scope, eq(issueRelations.issueId, request.blockerIssueId))).limit(1);
    const blocker = dependency?.edge;
    if (!blocker || readiness.unresolvedBlockerIssueIds.some((id: string) => id !== blocker.issueId)) {
      throw conflict("The selected dependency is missing or other unresolved blockers remain", { code: "route_restore_blockers_changed" });
    }

    const preview = {
      issueId,
      activityId: source.id,
      blockerIssueId: blocker.issueId,
      expectedVersion,
      status: "in_review" as const,
      stageIds: reset.policy.stages.map(stage => stage.id),
      currentStageId: reset.qa.id,
      nextStageId: reset.designer.id,
      assigneeAgentId: reset.qaAgentId,
      nextAssigneeAgentId: reset.designerAgentId,
      decisionIds,
    };
    if (request.dryRun) return { response: { ...preview, dryRun: true } };

    const auditActivityId = randomUUID();
    const [updated] = await tx.update(issues).set({
      status: preview.status,
      statusVersion: issue.statusVersion + 1,
      updatedAt: new Date(Math.max(Date.now(), issue.updatedAt.getTime() + 1)),
      assigneeAgentId: preview.assigneeAgentId,
      assigneeUserId: null,
      executionPolicy: { ...reset.policy },
      executionState: { ...reset.state, monitor: issue.executionState?.monitor },
      unblockDescriptor: null,
      blockedTransitionAt: null,
      blockedOwnerNotifiedAt: null,
    }).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
      .returning({ ...getTableColumns(issues), routeFingerprint: issueRouteFingerprint });
    const removed = await tx.delete(issueRelations).where(and(scope, eq(issueRelations.id, blocker.id)))
      .returning({ id: issueRelations.id });
    if (removed.length !== 1) {
      throw conflict("The selected dependency changed", { code: "route_restore_blockers_changed" });
    }
    const wakeupRequestId = await restoreWakeIntent(tx, { issue: updated, sourceActivityId: source.id,
      auditActivityId, agentId: preview.assigneeAgentId });
    const receipt = { ...preview, dryRun: false, auditActivityId, wakeupRequestId,
      version: { statusVersion: updated.statusVersion, updatedAt: updated.updatedAt.toISOString() } };
    const { publication } = await persistActivity(tx, {
      companyId,
      actorType: "user",
      actorId: input.operatorId,
      action: ISSUE_ROUTE_RESTORED,
      entityType: "issue",
      entityId: issueId,
      details: { sourceActivityId: source.id, decisionIds, blockerIssueId: blocker.issueId,
        removedDependency: blocker, expectedVersion, routeFingerprint: updated.routeFingerprint, before: routeProjection(issue),
        after: routeProjection(updated), receipt },
    }, { id: auditActivityId });
    return { response: receipt, publication };
  });
  if (result.publication) publishActivity(result.publication);
  return result.response;
}
