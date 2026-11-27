import { randomUUID } from "node:crypto";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  activityLog, agents, agentWakeupRequests, authUsers, companies, companyMemberships,
  createDb, executionWorkspaces, heartbeatRuns, issueExecutionDecisions, issueRecoveryActions, issueRelations,
  issues, workspaceOperations, type Db,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
// The incident fixtures retain the original stage IDs, decision evidence and dates.
import incidents from "./fixtures/issue-route-reset-incidents.json" with { type: "json" };
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";

import type { AdapterExecutionContext } from "../adapters/index.js";

const fixtureAdapterType = "route_restoration_fixture";
const isolatedAdapterResult = { exitCode: 0, signal: null, timedOut: false,
  errorMessage: null, summary: "Isolated run", provider: "test", model: "test-model" };
const invokeAdapter = vi.fn(async (_context: AdapterExecutionContext) => isolatedAdapterResult);

const support = await getEmbeddedPostgresTestSupport();
type Incident = keyof typeof incidents;
type Issue = typeof issues.$inferSelect;

describe.skipIf(!support.supported)("Board restoration of a lost execution route", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let issueRoutes: typeof import("../routes/issues.js").issueRoutes;
  let heartbeatService: typeof import("../services/heartbeat.js").heartbeatService;
  let unregisterAdapter: (() => void) | undefined;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-route-restoration-");
    db = createDb(database.connectionString);
    ({ issueRoutes } = await import("../routes/issues.js"));
    ({ heartbeatService } = await import("../services/heartbeat.js"));
    const { registerServerAdapter, unregisterServerAdapter } = await import("../adapters/index.js");
    const { processAdapter } = await import("../adapters/process/index.js");
    registerServerAdapter({ ...processAdapter, type: fixtureAdapterType, supportsLocalAgentJwt: false, execute: invokeAdapter });
    unregisterAdapter = () => unregisterServerAdapter(fixtureAdapterType);
  }, 240_000);

  afterEach(() => {
    vi.unstubAllEnvs();
    invokeAdapter.mockClear();
  });
  afterAll(async () => {
    unregisterAdapter?.();
    await db?.$client.end();
    await database?.cleanup();
  });

  function app(actor: Express.Request["actor"]) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    server.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
    server.use(errorHandler);
    return request(server);
  }

  function session(companyId: string, userId: string, role = "operator"): Express.Request["actor"] {
    return { type: "board", source: "session", userId, companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: role }] };
  }

  async function seed(
    name: Incident = "LEA-1901",
    useOriginalIds = false,
    reviewRequest: { instructions: string } | null = null,
  ) {
    const incident = incidents[name];
    const companyId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const issueId = useOriginalIds ? incident.issue.id : randomUUID();
    const blockerIssueId = randomUUID();
    const resolvedIssueId = randomUUID();
    const activityId = useOriginalIds ? incident.source.id : randomUUID();
    const board = { type: "board", source: "local_implicit", userId: "local-board" } as const;
    const original = structuredClone(incident.source.details);
    const policy = original._previous.executionPolicy;
    const originalAgentIds = policy.stages.map(stage => stage.participants[0].agentId);
    const agentIds = new Map(originalAgentIds.map(id => [id, useOriginalIds && name === "LEA-1901" ? id : randomUUID()]));
    const remap = (id: string) => agentIds.get(id)!;
    const [architect, fullstack, qa, designer] = originalAgentIds.map(remap);
    for (const stage of policy.stages) stage.participants[0].agentId = remap(stage.participants[0].agentId);
    original._previous.assigneeAgentId = qa;
    original.assigneeAgentId = fullstack;
    original._previous.executionState.currentParticipant.agentId = qa;
    original._previous.executionState.returnAssignee.agentId = fullstack;
    const previousState = { ...original._previous.executionState, reviewRequest };
    const snapshot = {
      ...original,
      _previous: { ...original._previous, executionState: previousState },
      changes: {
        ...original.changes,
        executionPolicy: { from: structuredClone(policy), to: original.executionPolicy },
        executionState: { from: structuredClone(previousState), to: original.executionState },
      },
    };

    const responsibleUserId = `owner-${companyId}`;
    await db.insert(authUsers).values({ id: responsibleUserId, name: "Fixture owner", email: `${responsibleUserId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Isolated restoration", defaultResponsibleUserId: responsibleUserId,
      issuePrefix });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: responsibleUserId,
      membershipRole: "owner", status: "active" });
    await db.insert(agents).values([
      { id: architect, name: "Architect" }, { id: fullstack, name: "Fullstack" },
      { id: qa, name: "QA Engineer" }, { id: designer, name: "Product Designer" },
    ].map(agent => ({ ...agent, companyId, role: "engineer", status: "active", adapterType: fixtureAdapterType,
      adapterConfig: { command: "/usr/bin/true" }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } })));
    await db.insert(issues).values([
      { ...incident.issue, id: issueId, companyId, title: "Original task", identifier: useOriginalIds ? name : `${issuePrefix}-1`,
        assigneeAgentId: fullstack, responsibleUserId, updatedAt: new Date(incident.issue.updatedAt) },
      { id: blockerIssueId, companyId, title: "Recovery dependency", status: "blocked" },
      { id: resolvedIssueId, companyId, title: "Completed dependency", status: "done" },
    ]);
    await db.insert(issueRelations).values([blockerIssueId, resolvedIssueId].map(id => ({
      companyId, issueId: id, relatedIssueId: issueId, type: "blocks" as const,
    })));
    await db.insert(activityLog).values([
      { ...incident.source, companyId, id: activityId, entityId: issueId, details: snapshot,
        actorId: qa, createdAt: new Date(incident.source.createdAt) },
      ...incident.later.map(row => ({ companyId, id: randomUUID(), entityType: "issue", entityId: issueId,
        action: "issue.updated", actorType: "agent", actorId: fullstack,
        details: { changes: { executionPolicy: { from: snapshot.executionPolicy, to: null } } },
        createdAt: new Date(row.createdAt) })),
    ]);
    const decisionRows = await db.insert(issueExecutionDecisions).values(incident.decisions.map(decision => ({
      ...decision, id: useOriginalIds ? decision.id : randomUUID(), companyId, issueId,
      actorAgentId: remap(decision.actorAgentId),
      createdAt: new Date(decision.createdAt), updatedAt: new Date(decision.updatedAt),
    }))).returning();
    if (!useOriginalIds) {
      snapshot._previous.executionState.lastDecisionId = decisionRows[1].id;
      snapshot.changes.executionState.from.lastDecisionId = decisionRows[1].id;
      await db.update(activityLog).set({ details: snapshot }).where(eq(activityLog.id, activityId));
    }
    const endpoint = `/api/issues/${issueId}/execution-policy/restore-from-activity`;
    const preview = (actor = board as Express.Request["actor"]) => app(actor).post(endpoint)
      .send({ activityId, blockerIssueId, dryRun: true });
    const apply = (expectedVersion: unknown, actor = board as Express.Request["actor"]) => app(actor).post(endpoint)
      .send({ activityId, blockerIssueId, expectedVersion, dryRun: false });
    return { companyId, issueId, blockerIssueId, resolvedIssueId, activityId, endpoint,
      board, architect, fullstack, qa, designer, responsibleUserId, policy, snapshot, decisionRows, preview, apply };
  }

  async function readIssue(id: string): Promise<Issue> {
    const [issue] = await db.select().from(issues).where(eq(issues.id, id));
    return issue;
  }

  function wakes(issueId: string) {
    return db.select().from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`);
  }

  function audits(issueId: string) {
    return db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId),
      eq(activityLog.action, "issue.execution_policy_restored")));
  }

  it.each([
    { name: "LEA-1901", reviewRequest: null },
    { name: "LEA-1928", reviewRequest: { instructions: "Verify the restored route before approving." } },
  ] as const)(
    "restores $name from its stage IDs and decisions through the queue, then moves from QA to Designer",
    async ({ name, reviewRequest }) => {
      const f = await seed(name, true, reviewRequest);
      const before = await readIssue(f.issueId);
      const preview = await f.preview().expect(200);
      expect(preview.body).toMatchObject({ dryRun: true, status: "in_review",
        stageIds: f.policy.stages.map(stage => stage.id), currentStageId: f.policy.stages[2].id,
        nextStageId: f.policy.stages[3].id, assigneeAgentId: f.qa, nextAssigneeAgentId: f.designer,
        blockerIssueId: f.blockerIssueId, decisionIds: f.decisionRows.map(decision => decision.id) });
      expect(await readIssue(f.issueId)).toEqual(before);
      expect(await audits(f.issueId)).toHaveLength(0);
      expect(await wakes(f.issueId)).toHaveLength(0);

      const applied = await f.apply(preview.body.expectedVersion).expect(200);
      const restored = await readIssue(f.issueId);
      expect(restored).toMatchObject({ status: "in_review", statusVersion: before.statusVersion + 1,
        assigneeAgentId: f.qa, executionPolicy: f.policy, executionState: {
          ...f.snapshot._previous.executionState, monitor: before.executionState?.monitor,
        } });
      const edges = await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, f.issueId));
      expect(edges.map(edge => edge.issueId)).toEqual([f.resolvedIssueId]);
      const [audit] = await audits(f.issueId);
      expect(audit).toMatchObject({ id: applied.body.auditActivityId, actorType: "user", actorId: "local-board",
        details: { sourceActivityId: f.activityId, decisionIds: preview.body.decisionIds,
          before: { status: "blocked", assigneeAgentId: f.fullstack },
          after: { status: "in_review", assigneeAgentId: f.qa },
          removedDependency: { issueId: f.blockerIssueId, relatedIssueId: f.issueId },
          receipt: applied.body } });
      expect(await wakes(f.issueId)).toEqual([expect.objectContaining({ id: applied.body.wakeupRequestId,
        agentId: f.qa, status: "queued", idempotencyKey: expect.stringContaining(`${f.issueId}:${f.activityId}`) })]);

      // A new scheduler reads the committed outbox. Hold the test adapter so
      // the ordinary QA verdict is bound to the actual claimed run.
      const heartbeat = heartbeatService(db);
      const dispatch = { companyId: f.companyId, requestId: applied.body.wakeupRequestId };
      if (name === "LEA-1901") {
        await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.qa));
        await heartbeat.dispatchPendingNativeStatusWakeups(dispatch);
        expect(await wakes(f.issueId)).toEqual([expect.objectContaining({ id: dispatch.requestId, status: "queued" })]);
        expect(invokeAdapter).not.toHaveBeenCalled();
        await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.qa));
      }
      let finishQa!: () => void;
      const qaFinished = new Promise<void>(resolve => { finishQa = resolve; });
      invokeAdapter.mockImplementationOnce(async context => {
        context.signal?.addEventListener("abort", finishQa, { once: true });
        try {
          await qaFinished;
          return isolatedAdapterResult;
        } finally {
          context.signal?.removeEventListener("abort", finishQa);
        }
      });
      let qaRunId!: string;
      try {
        await Promise.all([heartbeat.dispatchPendingNativeStatusWakeups(dispatch),
          heartbeatService(db).dispatchPendingNativeStatusWakeups(dispatch)]);
        await vi.waitFor(() => expect(invokeAdapter).toHaveBeenCalledOnce(), { timeout: 10_000 });
        const qaRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issueId));
        const executionStage = {
          wakeRole: "reviewer",
          stageId: f.policy.stages[2].id,
          stageType: "review",
          currentParticipant: { type: "agent", agentId: f.qa, userId: null },
          returnAssignee: { type: "agent", agentId: f.fullstack, userId: null },
          reviewRequest,
          lastDecisionOutcome: "approved",
          allowedActions: ["approve", "request_changes"],
        };
        expect(qaRuns).toHaveLength(1);
        const [qaRun] = qaRuns;
        expect(qaRun.agentId).toBe(f.qa);
        expect(qaRun.status).toBe("running");
        expect(qaRun.contextSnapshot?.wakeReason).toBe("issue_execution_policy_restored");
        expect(qaRun.contextSnapshot?.restorationActivityId).toBe(audit.id);
        expect(qaRun.contextSnapshot?.executionStage).toEqual(executionStage);
        qaRunId = qaRun.id;
        const [adapterInput] = invokeAdapter.mock.calls[0];
        expect(adapterInput.runId).toBe(qaRunId);
        expect(adapterInput.context.paperclipWake).toMatchObject({ executionStage });
        const prompt = renderPaperclipWakePrompt(adapterInput.context.paperclipWake);
        expect(prompt).toContain("You are waking as the active reviewer for this issue.");
        expect(prompt).toContain("allowed actions: approve, request_changes");
        if (reviewRequest) expect(prompt).toContain(reviewRequest.instructions);
        expect(await readIssue(f.issueId)).toMatchObject({ executionRunId: qaRunId, status: "in_review" });
        const agent: Express.Request["actor"] = {
          type: "agent", source: "agent_jwt", companyId: f.companyId, agentId: f.qa, runId: qaRunId,
          onBehalfOfUserId: f.responsibleUserId,
          onBehalfOfMemberships: [{ companyId: f.companyId, membershipRole: "owner", status: "active" }],
        };
        const verdict = await app(agent).patch(`/api/issues/${f.issueId}`)
          .send({ status: "done", comment: `verified: ${"a".repeat(40)}` });
        expect(verdict.status, JSON.stringify(verdict.body)).toBe(200);
        expect(await readIssue(f.issueId)).toMatchObject({ status: "in_review", assigneeAgentId: f.designer,
          executionState: { status: "pending", currentStageId: f.policy.stages[3].id,
            completedStageIds: f.policy.stages.slice(0, 3).map(stage => stage.id) } });
      } finally {
        finishQa();
        await heartbeat.drainActiveRunExecutions();
      }
      const decisions = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId))
        .orderBy(issueExecutionDecisions.createdAt);
      expect(decisions.slice(0, 2)).toEqual(f.decisionRows);
      expect(decisions[2]).toMatchObject({ stageId: f.policy.stages[2].id, outcome: "approved", actorAgentId: f.qa });
      expect((await f.apply(preview.body.expectedVersion).expect(200)).body).toEqual(applied.body);
      expect(await audits(f.issueId)).toHaveLength(1);
      const restorationWakes = (await wakes(f.issueId)).filter(wake => wake.idempotencyKey?.includes(f.activityId));
      expect(restorationWakes.filter(wake => wake.runId).map(wake => wake.runId)).toEqual([qaRunId, qaRunId]);
    },
    30_000,
  );

  it("requires Board and current company/task mutation access on preview and apply", async () => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    const f = await seed();
    const viewer = `viewer-${f.companyId}`;
    const operator = `operator-${f.companyId}`;
    await db.insert(authUsers).values([viewer, operator].map(id => ({ id, name: id, email: `${id}@example.test`,
      createdAt: new Date(), updatedAt: new Date() })));
    await db.insert(companyMemberships).values([
      { principalId: viewer, membershipRole: "viewer" }, { principalId: operator, membershipRole: "operator" },
    ].map(member => ({ ...member, companyId: f.companyId, principalType: "user", status: "active" })));
    const agent: Express.Request["actor"] = {
      type: "agent", source: "agent_key", companyId: f.companyId, agentId: f.qa,
    };
    const foreign = session(randomUUID(), operator);
    const { body } = await f.preview().expect(200);
    await db.update(issues).set({ visibility: "private", privacyRootIssueId: f.issueId }).where(eq(issues.id, f.issueId));
    for (const [actor, status] of [
      [agent, 403], [foreign, 404], [session(f.companyId, viewer, "viewer"), 403],
      [session(f.companyId, operator), 404],
    ] as const) {
      await f.preview(actor).expect(status);
      await f.apply(body.expectedVersion, actor).expect(status);
    }
    expect(await audits(f.issueId)).toHaveLength(0);
    expect(await wakes(f.issueId)).toHaveLength(0);
  });

  it("rejects either stale version component, missing version and client-supplied route state", async () => {
    const f = await seed();
    const { body: { expectedVersion } } = await f.preview().expect(200);
    await f.apply({ ...expectedVersion, statusVersion: expectedVersion.statusVersion + 1 }).expect(409);
    await f.apply({ ...expectedVersion, updatedAt: "2026-11-27T00:00:00.000Z" }).expect(409);
    await f.apply(undefined).expect(400);
    await app(f.board).post(f.endpoint).send({
      activityId: f.activityId, blockerIssueId: f.blockerIssueId, dryRun: false, expectedVersion,
      executionPolicy: f.policy,
    }).expect(400);
    expect(await audits(f.issueId)).toHaveLength(0);
  });

  it.each(["running", "queued", "scheduled_retry"] as const)("rejects a competing %s run without checkout", async status => {
    const f = await seed();
    const { body: { expectedVersion } } = await f.preview().expect(200);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.fullstack, status,
      contextSnapshot: { issueId: f.issueId } });
    const rejected = await f.apply(expectedVersion).expect(409);
    expect(rejected.body.details.code).toBe("route_restore_issue_busy");
    expect(await audits(f.issueId)).toHaveLength(0);
  });

  it("rejects a pending wake, another unresolved dependency and active recovery", async () => {
    const f = await seed();
    const { body: { expectedVersion } } = await f.preview().expect(200);
    const [pending] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.fullstack,
      source: "assignment", status: "deferred_issue_execution", payload: { taskId: f.issueId } }).returning();
    expect((await f.apply(expectedVersion).expect(409)).body.details.code).toBe("route_restore_issue_busy");
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, pending.id));
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.resolvedIssueId));
    expect((await f.apply(expectedVersion).expect(409)).body.details.code).toBe("route_restore_blockers_changed");
    const [workspace] = await db.insert(executionWorkspaces).values({
      companyId: f.companyId, name: "Still finalizing", mode: "isolated", strategyType: "git_worktree",
    }).returning();
    await db.update(issues).set({ status: "done", executionWorkspaceId: workspace.id }).where(eq(issues.id, f.resolvedIssueId));
    const [finalize] = await db.insert(workspaceOperations).values({ companyId: f.companyId,
      issueId: f.resolvedIssueId, executionWorkspaceId: workspace.id, phase: "workspace_finalize", status: "running",
    }).returning();
    expect((await f.apply(expectedVersion).expect(409)).body.details.code).toBe("route_restore_blockers_changed");
    await db.delete(workspaceOperations).where(eq(workspaceOperations.id, finalize.id));
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "test", cause: "test", fingerprint: "test", nextAction: "test" });
    expect((await f.apply(expectedVersion).expect(409)).body.details.code).toBe("route_restore_issue_busy");
  });

  it("rejects a foreign source, altered decision evidence and a later replacement route", async () => {
    const f = await seed();
    const other = await seed("LEA-1928");
    const foreign = await app(f.board).post(f.endpoint)
      .send({ activityId: other.activityId, blockerIssueId: f.blockerIssueId, dryRun: true }).expect(409);
    expect(foreign.body.details.code).toBe("route_restore_invalid_source");
    const delivery = f.decisionRows[1];
    await db.update(issueExecutionDecisions).set({ body: delivery.body.replace(/reviewed=[a-f0-9]{40}/, `reviewed=${"f".repeat(40)}`) })
      .where(eq(issueExecutionDecisions.id, delivery.id));
    expect((await f.preview().expect(409)).body.details.code).toBe("route_restore_invalid_source");
    await db.update(issueExecutionDecisions).set({ body: delivery.body }).where(eq(issueExecutionDecisions.id, delivery.id));
    await db.insert(activityLog).values({ companyId: f.companyId, entityType: "issue", entityId: f.issueId,
      action: "issue.updated", actorType: "user", actorId: "local-board",
      details: { changes: { executionPolicy: { from: f.policy, to: null } } } });
    expect((await f.preview().expect(409)).body.details.code).toBe("route_restore_issue_changed");
  });

  it("rejects decisions written after delivery and conflicting copies of the snapshot", async () => {
    const f = await seed();
    const timestamp = new Date(new Date(incidents["LEA-1901"].source.createdAt).getTime() - 1);
    const [laterDecision] = await db.insert(issueExecutionDecisions).values({
      companyId: f.companyId, issueId: f.issueId, stageId: f.policy.stages[2].id,
      stageType: "review", actorAgentId: f.qa, outcome: "approved",
      body: `verified: ${"b".repeat(40)}`, createdAt: timestamp, updatedAt: timestamp,
    }).returning();
    expect((await f.preview().expect(409)).body.details.code).toBe("route_restore_invalid_source");
    await db.delete(issueExecutionDecisions).where(eq(issueExecutionDecisions.id, laterDecision.id));
    const snapshot = structuredClone(f.snapshot);
    snapshot._previous.executionPolicy.stages[3].participants[0].agentId = randomUUID();
    await db.update(activityLog).set({ details: snapshot }).where(eq(activityLog.id, f.activityId));
    expect((await f.preview().expect(409)).body.details.code).toBe("route_restore_invalid_source");
  });

  it("refuses unavailable QA and retires a deferred intent superseded by a policy-only edit", async () => {
    const f = await seed();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } }).where(eq(agents.id, f.qa));
    expect((await f.preview().expect(409)).body.details.code).toBe("route_restore_participant_unavailable");
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).where(eq(agents.id, f.qa));
    const { body: { expectedVersion } } = await f.preview().expect(200);
    const { body: applied } = await f.apply(expectedVersion).expect(200);
    const heartbeat = heartbeatService(db);
    const dispatch = { companyId: f.companyId, requestId: applied.wakeupRequestId };
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true, maxDailyRuns: 0 } } }).where(eq(agents.id, f.qa));
    await heartbeat.dispatchPendingNativeStatusWakeups(dispatch);
    expect(await wakes(f.issueId)).toEqual([expect.objectContaining({ id: dispatch.requestId, status: "queued" })]);

    const policy = structuredClone(f.policy);
    policy.stages[3].approvalCommentPattern = "^new-design-verdict:";
    await db.update(issues).set({ executionPolicy: policy }).where(eq(issues.id, f.issueId));
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).where(eq(agents.id, f.qa));
    await heartbeat.dispatchPendingNativeStatusWakeups(dispatch);
    expect((await wakes(f.issueId)).find(wake => wake.id === applied.wakeupRequestId)?.status).toBe("skipped");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issueId))).toHaveLength(0);
  });

  it.each(["maxDailyRuns", "maxDailyCostCents", "dependency"] as const)("retries the same QA wake after temporary %s refusal", async gate => {
    const f = await seed();
    const { body: { expectedVersion } } = await f.preview().expect(200);
    const { body: applied } = await f.apply(expectedVersion).expect(200);
    const setGate = async (blocked: boolean) => {
      if (gate === "dependency") {
        await app(f.board).patch(`/api/issues/${f.issueId}`).send({
          blockedByIssueIds: blocked ? [f.resolvedIssueId, f.blockerIssueId] : [f.resolvedIssueId],
        }).expect(200);
      } else {
        await db.update(agents).set({ runtimeConfig: {
          heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1, [gate]: blocked ? 0 : 5 },
        } }).where(eq(agents.id, f.qa));
      }
    };
    const readRuns = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issueId));
    const dispatch = { companyId: f.companyId, requestId: applied.wakeupRequestId };
    const heartbeat = heartbeatService(db);
    const scheduleRetry = vi.fn();

    await setGate(true);
    expect(await heartbeat.dispatchPendingNativeStatusWakeups({ ...dispatch, onDeferredDeadline: scheduleRetry }))
      .toEqual({ scanned: 1, dispatched: 0, recovered: 0, deferred: 1 });
    expect(await readRuns()).toHaveLength(0);
    expect(invokeAdapter).not.toHaveBeenCalled();
    expect(await wakes(f.issueId)).toEqual([expect.objectContaining({ id: dispatch.requestId, status: "queued",
      runId: null, claimedAt: null, finishedAt: null })]);
    expect(scheduleRetry).toHaveBeenCalledOnce();
    expect(scheduleRetry.mock.calls[0][0]).toBeGreaterThan(Date.now());
    expect(await readIssue(f.issueId)).toMatchObject({ status: "in_review", assigneeAgentId: f.qa });

    await setGate(false);
    const restarted = heartbeatService(db);
    try {
      await Promise.all([heartbeat.dispatchPendingNativeStatusWakeups(dispatch),
        restarted.dispatchPendingNativeStatusWakeups(dispatch)]);
      await vi.waitFor(() => expect(invokeAdapter).toHaveBeenCalledOnce(), { timeout: 10_000 });
    } finally {
      await Promise.all([heartbeat.drainActiveRunExecutions(), restarted.drainActiveRunExecutions()]);
    }
    expect((await f.apply(expectedVersion).expect(200)).body).toEqual(applied);
    expect(await restarted.dispatchPendingNativeStatusWakeups(dispatch)).toEqual({ scanned: 0, dispatched: 0, recovered: 0, deferred: 0 });
    expect(invokeAdapter).toHaveBeenCalledOnce();
    const runs = await readRuns();
    expect(runs).toEqual([expect.objectContaining({ agentId: f.qa, wakeupRequestId: applied.auditActivityId })]);
    expect(await wakes(f.issueId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: dispatch.requestId, status: "coalesced", runId: runs[0].id }),
      expect.objectContaining({ id: applied.auditActivityId, runId: runs[0].id }),
    ]));
    expect(await wakes(f.issueId)).toHaveLength(2);
    expect(await audits(f.issueId)).toHaveLength(1);
  }, 30_000);

  it("returns one durable receipt for simultaneous applies", async () => {
    const f = await seed();
    const { body: { expectedVersion } } = await f.preview().expect(200);
    const results = await Promise.all([f.apply(expectedVersion).expect(200), f.apply(expectedVersion).expect(200)]);
    expect(results[0].body).toEqual(results[1].body);
    expect(await audits(f.issueId)).toHaveLength(1);
    expect(await wakes(f.issueId)).toHaveLength(1);
    const replay = await app(f.board).post(f.endpoint).send({
      activityId: f.activityId.toUpperCase(), blockerIssueId: f.blockerIssueId.toUpperCase(), expectedVersion, dryRun: false,
    }).expect(200);
    expect(replay.body).toEqual(results[0].body);
    const changedRequest = await app(f.board).post(f.endpoint).send({
      activityId: f.activityId, blockerIssueId: f.resolvedIssueId, expectedVersion, dryRun: false,
    }).expect(409);
    expect(changedRequest.body.details.code).toBe("route_restore_already_applied");
  });

  it("rolls back the assignment, dependency removal and queued wake if the audit write fails", async () => {
    const f = await seed();
    const before = await readIssue(f.issueId);
    const { body: { expectedVersion } } = await f.preview().expect(200);
    await db.execute(sql.raw(`CREATE FUNCTION fail_restore_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'issue.execution_policy_restored' THEN
          RAISE EXCEPTION 'Injected restoration audit failure';
        END IF;
        RETURN NEW;
      END; $$`));
    await db.execute(sql.raw(`CREATE TRIGGER fail_restore_audit BEFORE INSERT ON activity_log
      FOR EACH ROW EXECUTE FUNCTION fail_restore_audit()`));
    try {
      await f.apply(expectedVersion).expect(500);
      expect(await readIssue(f.issueId)).toEqual(before);
      expect(await audits(f.issueId)).toHaveLength(0);
      expect(await wakes(f.issueId)).toHaveLength(0);
      expect(await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, f.issueId))).toHaveLength(2);
    } finally {
      await db.execute(sql.raw("DROP TRIGGER fail_restore_audit ON activity_log"));
      await db.execute(sql.raw("DROP FUNCTION fail_restore_audit()"));
    }
    await f.apply(expectedVersion).expect(200);
  });
});
