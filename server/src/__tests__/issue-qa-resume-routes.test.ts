import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueRelations,
  issues,
  issueThreadInteractions,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { getServerAdapter, registerServerAdapter } from "../adapters/index.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { heartbeatService } from "../services/heartbeat.js";
import type { StorageService } from "../storage/types.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("resume saved Cards QA via HTTP", () => {
  const companyId = randomUUID();
  const implementer = randomUUID();
  const reviewer = randomUUID();
  const qa = randomUUID();
  const ceo = "9cadde33-aa45-4828-b66e-e99cb4d33212";
  const historicReturn = "ec1c4b0c-4bb0-4a7c-a6b4-927678af5d47";
  const historicAnswer = "baad9173-8028-4e97-810e-75eb2daa5db9";
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let app: ReturnType<typeof express>;
  let issueNumber = 3000;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "isolated-qa-resume-test");
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-qa-resume-");
    db = createDb(temporary.connectionString, { maxConnections: 1 });
    await db.insert(companies).values({ id: companyId, name: "Cards fixture", issuePrefix: "LEA" });
    await db.insert(agents).values([implementer, reviewer, qa, ceo].map((id, index) => ({
      id,
      companyId,
      name: `Agent ${index}`,
      role: id === ceo ? "ceo" : "engineer",
      status: "idle",
      adapterType: "process",
    })));
    app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as StorageService));
    app.use(errorHandler);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
  });

  async function fixture(options: { historical?: boolean; identifier?: string; stagePattern?: string } = {}) {
    const historical = options.historical ?? false;
    const identifier = options.identifier ?? (historical ? "LEA-1880" : `LEA-${++issueNumber}`);
    const issueId = randomUUID();
    const runId = randomUUID();
    const reviewed = randomUUID();
    const delivered = randomUUID();
    const stageId = randomUUID();
    const returnDecisionId = historical ? historicReturn : randomUUID();
    const ceoInteractionId = historical ? historicAnswer : randomUUID();
    const participant = (agentId: string) => ({ type: "agent" as const, agentId, userId: null });
    const executionPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [
        { id: reviewed, type: "review", agentId: reviewer, approvalCommentPattern: "^reviewed: " },
        { id: delivered, type: "delivery", agentId: implementer, approvalCommentPattern: "^delivery: " },
        { id: stageId, type: "review", agentId: qa, approvalCommentPattern: options.stagePattern ?? "^verified: [0-9a-f]{40}" },
      ].map(({ agentId, ...stage }) => ({
        ...stage,
        approvalsNeeded: 1,
        participants: [{ id: randomUUID(), ...participant(agentId) }],
      })),
    };
    const executionState = {
      status: "changes_requested",
      currentStageId: stageId,
      currentStageType: "review",
      currentStageIndex: 2,
      currentParticipant: participant(qa),
      returnAssignee: participant(implementer),
      completedStageIds: [reviewed, delivered],
      lastDecisionId: returnDecisionId,
      lastDecisionOutcome: "changes_requested",
      reviewRequest: null,
      monitor: null,
      changesRequestedCount: 3,
    };
    await db.insert(issues).values({
      id: issueId, companyId, identifier, title: identifier, assigneeAgentId: implementer,
      status: "in_progress", statusVersion: 12, executionPolicy, executionState,
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: implementer, issueId, status: "running",
      contextSnapshot: { issueId },
    });
    const [issue] = await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId })
      .where(eq(issues.id, issueId)).returning();
    const decisionCreatedAt = new Date("2026-11-27T03:00:00Z");
    await db.insert(issueExecutionDecisions).values([
      { stageId: reviewed, stageType: "review", actorAgentId: reviewer, outcome: "approved", body: "reviewed: fixture" },
      { stageId: delivered, stageType: "delivery", actorAgentId: implementer, outcome: "approved", body: "delivery: fixture" },
      { stageId, stageType: "review", actorAgentId: qa, outcome: "changes_requested", body: "Earlier QA return" },
      { id: returnDecisionId, stageId, stageType: "review", actorAgentId: qa, outcome: "changes_requested", body: "Current QA return" },
    ].map((decision) => ({ ...decision, issueId, companyId, createdAt: decisionCreatedAt })));
    const marker = `pc-resume-qa: ${identifier} return=${returnDecisionId}`;
    const answer = (otherText: string) => ({
      version: 1 as const,
      answers: [{ questionId: "restore_route", optionIds: ["paperclip_text_answer"], otherText }],
    });
    await db.insert(issueThreadInteractions).values({
      id: ceoInteractionId, companyId, issueId, kind: "ask_user_questions", status: "answered",
      resolvedByAgentId: ceo, createdAt: new Date("2026-11-27T03:03:00Z"), resolvedAt: new Date("2026-11-27T03:05:00Z"),
      payload: {
        version: 1,
        questions: [
          {
            id: "restore_route", prompt: "Resume QA?", selectionMode: "single", allowOther: true,
            options: [{ id: "paperclip_text_answer", label: "Type an answer", freeText: true }],
          },
          {
            id: "quote_for_context", prompt: "Quote for context", selectionMode: "single", allowOther: true,
            options: [{ id: "paperclip_text_answer", label: "Type an answer", freeText: true }],
          },
        ],
      },
      result: answer(historical ? "Возобновить сохранённую QA" : `${marker}\nContinue the saved QA.`),
    });
    const body = {
      stageId, returnDecisionId, ceoInteractionId, statusVersion: issue!.statusVersion,
      updatedAt: issue!.updatedAt.toISOString(), comment: "QA resumes with the reviewed and delivered package.",
    };
    const history = () => db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, issueId))
      .orderBy(issueExecutionDecisions.id);
    const snapshot = async () => ({
      issue: (await db.select().from(issues).where(eq(issues.id, issueId)))[0],
      decisions: await history(),
      comments: await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)),
      audit: await db.select().from(activityLog).where(eq(activityLog.entityId, issueId)),
      wakes: await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
      )).orderBy(agentWakeupRequests.id),
    });
    const authorization = (ownerRun: string = runId) => `Bearer ${createLocalAgentJwt(implementer, companyId, "process", ownerRun)}`;
    const path = `/api/issues/${identifier}/resume-execution-stage`;
    const resume = (input = body, auth: string | null = authorization(), resumePath = path) => {
      const call = request(app).patch(resumePath);
      if (auth) call.set("Authorization", auth);
      return call.send(input);
    };
    return { issueId, runId, marker, answer, executionPolicy, executionState, body, path, authorization, resume, snapshot };
  }

  it("advertises PATCH on OPTIONS and atomically saves the resumed stage and one QA wake", async () => {
    const f = await fixture();
    const options = await request(app).options(f.path).expect(200);
    expect(options.headers.allow).toContain("PATCH");
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId, title: "Resolved defect", status: "done" });
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: f.issueId, type: "blocks" });
    const before = await f.snapshot();

    const responses = await Promise.all([f.resume(), f.resume()]);
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
    const response = responses.find((res) => res.status === 200)!;
    expect(response.body).toMatchObject({
      id: f.issueId, status: "in_review", assigneeAgentId: qa, assigneeUserId: null,
      statusVersion: f.body.statusVersion + 1, checkoutRunId: null, executionRunId: null,
      executionState: { ...f.executionState, status: "pending" },
    });
    expect(response.body.executionPolicy).toEqual(f.executionPolicy);
    const saved = await f.snapshot();
    expect(response.body.updatedAt).toBe(saved.issue?.updatedAt.toISOString());
    expect(saved.decisions).toEqual(before.decisions);
    expect(saved.comments).toMatchObject([{ body: f.body.comment, authorAgentId: implementer, createdByRunId: f.runId }]);
    expect(saved.audit).toHaveLength(2);
    expect(saved.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "issue.updated", agentId: implementer, runId: f.runId,
        details: expect.objectContaining({
          stageId: f.body.stageId, returnDecisionId: f.body.returnDecisionId, ceoInteractionId: f.body.ceoInteractionId,
        }),
      }),
      expect.objectContaining({
        action: "issue.comment_added", agentId: implementer, runId: f.runId,
        details: expect.objectContaining({ commentId: saved.comments[0]?.id }),
      }),
    ]));
    expect(saved.wakes).toMatchObject([{
      agentId: qa, source: "assignment", reason: "execution_review_requested",
      requestedByActorType: "agent", requestedByActorId: implementer,
      status: "deferred_issue_execution", runId: null,
      payload: {
        commentId: saved.comments[0]?.id,
        _paperclipWakeContext: {
          issueId: f.issueId, source: "issue.execution_stage",
          executionStage: {
            stageId: f.body.stageId, wakeRole: "reviewer", allowedActions: ["approve", "request_changes"],
          },
        },
      },
    }]);
  });

  it("accepts the historical decision only for its exact task identifier", async () => {
    const f = await fixture({ historical: true, identifier: "LEA-1881" });
    await expectRejection(f, 403, f.body, "issue_qa_resume_ceo_response_required");
    await db.update(issues).set({ identifier: "LEA-1880" }).where(eq(issues.id, f.issueId));
    await f.resume(f.body, f.authorization(), f.path.replace("LEA-1881", "LEA-1880")).expect(200);
    expect((await f.snapshot()).wakes).toHaveLength(1);
  });

  it.each(["todo", "cancelled"] as const)("rejects a %s blocker without writes", async (status) => {
    const f = await fixture();
    const [blocker] = await db.insert(issues).values({ companyId, title: "Unresolved defect", status }).returning();
    await db.insert(issueRelations).values({ companyId, issueId: blocker!.id, relatedIssueId: f.issueId, type: "blocks" });
    await expectRejection(f, 409, f.body, "issue_qa_resume_unresolved_blockers");
  });

  it("does not commit while a done blocker is being reopened", async () => {
    const f = await fixture();
    const [blocker] = await db.insert(issues).values({ companyId, title: "Reopening defect", status: "done" }).returning();
    await db.insert(issueRelations).values({ companyId, issueId: blocker!.id, relatedIssueId: f.issueId, type: "blocks" });
    const concurrentDb = createDb(temporary.connectionString, { maxConnections: 1 });
    try {
      await concurrentDb.transaction(async (tx) => {
        await tx.update(issues).set({ status: "todo" }).where(eq(issues.id, blocker!.id));
        await expectRejection(f, 409, f.body, "issue_qa_resume_snapshot_changed");
      });
    } finally {
      await concurrentDb.$client.end();
    }
    await expectRejection(f, 409, f.body, "issue_qa_resume_unresolved_blockers");
  });

  it.each(["wrong resolver", "pending", "marker after first line", "different return", "different task", "superseded", "predates return"] as const)(
    "rejects an unconfirmed decision (%s) without writes",
    async (kind) => {
      const f = await fixture();
      const patch: Partial<typeof issueThreadInteractions.$inferInsert> = {
        "wrong resolver": { resolvedByAgentId: reviewer },
        "pending": { status: "pending", resolvedAt: null },
        "marker after first line": { result: f.answer(`For discussion only\n${f.marker}`) },
        "different return": { result: f.answer(f.marker.replace(f.body.returnDecisionId, randomUUID())) },
        "different task": { result: f.answer(f.marker.replace(/LEA-\d+/, "LEA-42")) },
        "superseded": { result: { ...f.answer(f.marker), outcome: "withdrawn" as const } },
        "predates return": { createdAt: new Date("2026-11-27T02:59:00Z") },
      }[kind];
      await db.update(issueThreadInteractions).set(patch).where(eq(issueThreadInteractions.id, f.body.ceoInteractionId));
      await expectRejection(f, 403, f.body, "issue_qa_resume_ceo_response_required");
    },
  );

  it("refuses a confirmed CEO answer stored on another task", async () => {
    const f = await fixture();
    const [other] = await db.insert(issues).values({ companyId, title: "Unrelated task" }).returning();
    await db.update(issueThreadInteractions).set({ issueId: other!.id }).where(eq(issueThreadInteractions.id, f.body.ceoInteractionId));
    await expectRejection(f, 403, f.body, "issue_qa_resume_ceo_response_required");
  });

  it("respects the CEO's denial when another answer quotes the approval marker", async () => {
    const f = await fixture();
    const denial = f.answer("QA resume denied");
    denial.answers.push({
      questionId: "quote_for_context", optionIds: ["paperclip_text_answer"], otherText: f.marker,
    });
    await db.update(issueThreadInteractions).set({ result: denial })
      .where(eq(issueThreadInteractions.id, f.body.ceoInteractionId));
    await expectRejection(f, 403, f.body, "issue_qa_resume_ceo_response_required");
  });

  it("refuses board auth and a different live run of the same assignee", async () => {
    const f = await fixture();
    const anotherRun = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: anotherRun, companyId, agentId: implementer, issueId: f.issueId, status: "running",
    });
    const before = await f.snapshot();
    await f.resume(f.body, null).expect(403);
    const response = await f.resume(f.body, f.authorization(anotherRun)).expect(409);
    expect(response.body.details?.code).toBe("issue_qa_resume_run_not_owner");
    expect(await f.snapshot()).toEqual(before);
  });

  it("refuses an execution lock held by a run admitted to another task", async () => {
    const f = await fixture();
    const [other] = await db.insert(issues).values({ companyId, title: "Other task" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: implementer, issueId: other!.id, status: "running",
      contextSnapshot: { issueId: f.issueId },
    }).returning();
    await db.update(issues).set({ checkoutRunId: run!.id, executionRunId: run!.id }).where(eq(issues.id, f.issueId));
    const before = await f.snapshot();
    const response = await f.resume(f.body, f.authorization(run!.id)).expect(409);
    expect(response.body.details?.code).toBe("issue_qa_resume_run_not_owner");
    expect(await f.snapshot()).toEqual(before);
  });

  it("accepts a current execution behind a finished checkout", async () => {
    const f = await fixture();
    const checkoutRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: checkoutRunId, companyId, agentId: implementer, issueId: f.issueId, status: "running",
    });
    await db.update(issues).set({ checkoutRunId }).where(eq(issues.id, f.issueId));
    await expectRejection(f, 409, f.body, "issue_qa_resume_run_not_owner");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, checkoutRunId));
    await f.resume().expect(200);
  });

  it.each(["version", "updatedAt"] as const)("refuses a changed %s under the original client snapshot", async (kind) => {
    const f = await fixture();
    const patch = {
      version: { statusVersion: f.body.statusVersion + 1 },
      updatedAt: { updatedAt: new Date(Date.parse(f.body.updatedAt) + 1) },
    }[kind];
    await db.update(issues).set(patch).where(eq(issues.id, f.issueId));
    await expectRejection(f, 409, f.body, "issue_qa_resume_snapshot_changed");
  });

  it.each(["currentStageId", "lastDecisionId"] as const)("checks %s again under the row lock", async (field) => {
    const f = await fixture();
    const concurrentDb = createDb(temporary.connectionString, { maxConnections: 2 });
    const release = Promise.withResolvers<void>();
    const locked = Promise.withResolvers<number>();
    const decision = randomUUID();
    const edit = concurrentDb.transaction(async (tx) => {
      await tx.update(issues).set({ executionState: { ...f.executionState, [field]: decision } }).where(eq(issues.id, f.issueId));
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      locked.resolve(backend!.pid);
      await release.promise;
    });
    const holder = await locked.promise;
    const before = await f.snapshot();
    const response = f.resume().then((result) => result);
    try {
      await vi.waitFor(async () => {
        const [observed] = await concurrentDb.execute<{ waiting: boolean }>(sql`
          select exists (select 1 from pg_stat_activity
            where datname = current_database() and ${holder} = any(pg_blocking_pids(pid))) as waiting
        `);
        expect(observed?.waiting).toBe(true);
      }, { timeout: 5_000 });
    } finally {
      release.resolve();
      await edit;
      await concurrentDb.$client.end();
    }
    expect((await response).status).toBe(409);
    const after = await f.snapshot();
    expect(after).toEqual({ ...before, issue: {
      ...before.issue, executionState: { ...f.executionState, [field]: decision },
    } });
  });

  it("rolls back its comment when the saved participant cannot receive the issue", async () => {
    const f = await fixture();
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, qa));
    try {
      await expectRejection(f, 409, f.body);
    } finally {
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, qa));
    }
  });

  it("refuses an architectural review even with a matching CEO answer", async () => {
    const f = await fixture({ stagePattern: "^reviewed: [0-9a-f]{40}" });
    await expectRejection(f, 409, f.body, "issue_qa_resume_snapshot_changed");
  });

  it("rolls back the saved wake when a later write in the transition fails", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    await db.execute(sql`
      create function fail_qa_resume_audit() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from agent_wakeup_requests
          where payload->>'issueId' = new.entity_id and payload->>'qaResumeReturnDecisionId' is not null)
        then raise exception 'Failure after saving the QA wake';
        end if;
        return new;
      end
      $$
    `);
    await db.execute(sql`
      create trigger fail_qa_resume_audit before insert on activity_log
      for each row when (new.action = 'issue.comment_added') execute function fail_qa_resume_audit()
    `);
    try {
      await f.resume().expect(500);
      expect(await f.snapshot()).toEqual(before);
    } finally {
      await db.execute(sql`drop trigger fail_qa_resume_audit on activity_log`);
      await db.execute(sql`drop function fail_qa_resume_audit()`);
    }
  });

  it.each(["stale return", "disabled wake-on-demand"] as const)("retires a deferred QA wake for a %s", async (scenario) => {
    const f = await fixture();
    const previousRuntime = await db.select({ runtimeConfig: agents.runtimeConfig }).from(agents)
      .where(eq(agents.id, qa)).then((rows) => rows[0]!.runtimeConfig);
    try {
      await f.resume().expect(200);
      if (scenario === "stale return") {
        await db.update(issues).set({ executionState: {
          ...f.executionState, status: "pending", lastDecisionId: randomUUID(),
        } }).where(eq(issues.id, f.issueId));
      } else {
        await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } }).where(eq(agents.id, qa));
      }
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      await heartbeatService(db).resumeQueuedRuns();
      expect((await f.snapshot()).wakes).toMatchObject([{
        status: "cancelled", runId: null,
        error: scenario === "stale return"
          ? "The saved QA return no longer matches the pending stage"
          : "On-demand wakes are disabled for the QA participant",
      }]);
    } finally {
      await db.update(agents).set({ runtimeConfig: previousRuntime }).where(eq(agents.id, qa));
    }
  });

  it.each(["legacy", "native"] as const)(
    "recovers the original QA wake once when delivery behind a %s run fails before its first write",
    async (runtimeMode) => {
      const f = await fixture();
      const userId = randomUUID();
      const previousQaRun = randomUUID();
      const busyQaRun = randomUUID();
      const now = new Date();
      await db.insert(authUsers).values({
        id: userId, name: "Test Operator", email: `${userId}@example.test`, createdAt: now, updatedAt: now,
      });
      await db.insert(companyMemberships).values({
        companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "admin",
      });
      await db.update(issues).set({ responsibleUserId: userId }).where(eq(issues.id, f.issueId));
      await db.update(heartbeatRuns).set({
        responsibleUserId: userId, startedAt: now, contextSnapshot: {}, runtimeMode,
        ...(runtimeMode === "native" ? { nativeIssueId: f.issueId, issueId: null } : {}),
      }).where(eq(heartbeatRuns.id, f.runId));
      await db.update(agents).set({
        adapterType: "codex_local", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      }).where(eq(agents.id, qa));
      await db.insert(heartbeatRuns).values({
        id: previousQaRun, companyId, agentId: qa, issueId: f.issueId, status: "succeeded",
        responsibleUserId: userId, createdAt: new Date("2026-11-26T02:58:00Z"),
        finishedAt: new Date("2026-11-26T03:00:00Z"),
      });
      await db.update(issueExecutionDecisions).set({ createdByRunId: previousQaRun })
        .where(eq(issueExecutionDecisions.id, f.body.returnDecisionId));

      const adapter = getServerAdapter("codex_local");
      const execute = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, resultJson: {} }));
      const queueDb = createDb(temporary.connectionString);
      const recoveryErrors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({
        owner: queueDb, canRun: () => true,
        onError: (error) => { recoveryErrors.push(error); },
      });
      registerServerAdapter({ ...adapter, execute });
      try {
        const response = await f.resume().expect(200);
        expect(response.body).toMatchObject({ status: "in_review", executionState: { status: "pending" } });
        await f.resume().expect(409);
        const saved = await f.snapshot();
        expect(saved.comments).toHaveLength(1);
        const commentId = saved.comments[0]!.id;

        // Persist the outgoing run's terminal state without its normal queue release.
        // An unrelated running QA turn keeps the recovered run queued for inspection.
        await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
        await db.insert(heartbeatRuns).values({
          id: busyQaRun, companyId, agentId: qa, responsibleUserId: userId, status: "running", startedAt: new Date(),
        });
        if (runtimeMode === "native") {
          await heartbeatService(queueDb).resumeQueuedRuns();
          expect((await f.snapshot()).wakes).toMatchObject([{ status: "deferred_issue_execution", runId: null }]);
          await db.insert(nativeRunFinalizations).values({
            companyId, issueId: f.issueId, runId: f.runId, phase: "committed",
          });
        }
        const [intent] = saved.wakes;
        expect(saved.wakes).toMatchObject([{
          status: "deferred_issue_execution", runId: null,
          payload: {
            commentId,
            executionStage: {
              stageId: f.body.stageId, stageType: "review", wakeRole: "reviewer",
              allowedActions: ["approve", "request_changes"],
            },
          },
        }]);
        await db.execute(sql`
          create function fail_qa_wake_delivery() returns trigger language plpgsql as $$
          begin
            raise exception 'Delivery unavailable before the first queue write';
          end
          $$
        `);
        await db.execute(sql`
          create trigger fail_qa_wake_delivery before update on agent_wakeup_requests
          for each row when (old.reason = 'execution_review_requested'
            and old.status = 'deferred_issue_execution')
          execute function fail_qa_wake_delivery()
        `);
        const failedDb = createDb(temporary.connectionString);
        try {
          const failedDelivery = heartbeatService(failedDb);
          await failedDelivery.reconcileStrandedAssignedIssues({
            companyId, issueId: f.issueId, skipRelatedRecovery: true,
          });
          expect((await f.snapshot()).wakes).toMatchObject([{ id: intent!.id, runId: null }]);
          const beforeFailure = await f.snapshot();
          await expect(failedDelivery.resumeQueuedRuns()).rejects.toMatchObject({
            cause: { message: "Delivery unavailable before the first queue write" },
          });
          expect((await f.snapshot()).wakes).toEqual(beforeFailure.wakes);
        } finally {
          await failedDb.$client.end();
          await db.execute(sql`drop trigger fail_qa_wake_delivery on agent_wakeup_requests`);
          await db.execute(sql`drop function fail_qa_wake_delivery()`);
        }

        const restarted = heartbeatService(queueDb);
        await Promise.all([
          restarted.registerDeferredReceiptWork(coordinator, () => true).ready,
          restarted.resumeQueuedRuns(),
        ]);
        await restarted.resumeQueuedRuns();

        const qaRuns = (await db.select().from(heartbeatRuns).where(and(
          eq(heartbeatRuns.agentId, qa),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`,
        )));
        expect(qaRuns).toHaveLength(1);
        const { wakes } = await f.snapshot();
        expect(wakes).toMatchObject([{
          id: intent!.id,
          runId: qaRuns[0]!.id,
          reason: "execution_review_requested",
          payload: { commentId, executionStage: intent!.payload?.executionStage },
        }]);
        expect(qaRuns[0]).toMatchObject({
          wakeupRequestId: intent!.id,
          status: "queued",
          contextSnapshot: {
            issueId: f.issueId,
            wakeReason: "execution_review_requested",
            commentId,
            executionStage: intent!.payload?.executionStage,
          },
        });
        expect(recoveryErrors).toEqual([]);
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await coordinator.stop();
        registerServerAdapter(adapter);
        await queueDb.$client.end();
      }
    },
  );

  async function expectRejection(
    f: Awaited<ReturnType<typeof fixture>>,
    status: number,
    body: Awaited<ReturnType<typeof fixture>>["body"],
    code?: string,
  ) {
    const before = await f.snapshot();
    const response = await f.resume(body).expect(status);
    if (code) expect(response.body.details?.code).toBe(code);
    expect(await f.snapshot()).toEqual(before);
  }
});
