import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, authUsers, companies, companyMemberships,
  createDb, heartbeatRuns, issueComments, issueExecutionDecisions, issueRelations,
  issues, issueThreadInteractions, projects,
} from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import type { StorageService } from "../storage/types.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const { supported } = await getEmbeddedPostgresTestSupport();
const describePostgres = supported ? describe : describe.skip;

describePostgres("resubmit a Cards review via HTTP", () => {
  const companyId = "bf0903fa-e62e-4dd2-b19b-5cacaa541460";
  const projectId = "8fd59ee4-3ccf-44c2-b149-5d678ce5b985";
  const ceo = "9cadde33-aa45-4828-b66e-e99cb4d33212";
  const implementer = randomUUID();
  const reviewer = randomUUID();
  const qa = randomUUID();
  const userId = randomUUID();
  const sha = "395d90eb3a4afc6aee4339cf03df13962ce51354";
  const pattern = {
    review: "^reviewed: [0-9a-f]{40}",
    delivery: "^delivery: from=[0-9a-f]{40} to=[0-9a-f]{40} reviewed=[0-9a-f]{40}",
    qa: "^verified: [0-9a-f]{40}",
  };
  const consumed = "issue.review_resubmission_consumed";
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let app: ReturnType<typeof express>;
  let issueNumber = 4100;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "isolated-review-resubmission-test");
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-review-resubmission-");
    db = createDb(temporary.connectionString, { maxConnections: 5 });
    await db.insert(companies).values({ id: companyId, name: "Cards fixture", issuePrefix: "LEA" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Cards" });
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId, name: "Test Operator", email: `${userId}@example.test`, createdAt: now, updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "admin",
    });
    await db.insert(agents).values([
      { id: implementer, name: "Fullstack Engineer", role: "engineer" },
      { id: reviewer, name: "Architect", role: "engineer" },
      { id: qa, name: "QA Engineer", role: "qa" },
      { id: ceo, name: "CEO", role: "ceo" },
    ].map((agent) => ({ ...agent, companyId, status: "idle", adapterType: "process" })));
    app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use((req, res, next) => {
      if (req.header("x-drop-response") === "true") {
        // The route calls json only after its transaction commits.
        res.json = () => { res.socket?.destroy(); return res; };
      }
      next();
    });
    app.use("/api", issueRoutes(db, {} as StorageService));
    app.use(errorHandler);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
  });

  const principal = (agentId: string) => ({ type: "agent" as const, agentId, userId: null });
  const answer = (otherText: string, questionId = "next_route") => ({
    version: 1 as const,
    answers: [{ questionId, optionIds: ["paperclip_text_answer"], otherText }],
  });

  async function fixture(historical = false) {
    const identifier = historical ? "LEA-2049" : `LEA-${++issueNumber}`;
    const issueId = historical ? "fcc11975-dfac-4d12-8b49-6f90182b3462" : randomUUID();
    const returnDecisionId = historical ? "af456ebd-4a00-4a1c-9eb3-2499ca84c79c" : randomUUID();
    const ceoInteractionId: string = historical ? "15bc20b1-b677-494d-ab4a-e4dff86f53fb" : randomUUID();
    const runId = randomUUID();
    const stageId = randomUUID();
    const executionPolicy = {
      mode: "normal" as const, commentRequired: true,
      stages: [
        { type: "review" as const, agentId: reviewer, approvalCommentPattern: pattern.review },
        { type: "delivery" as const, agentId: implementer, approvalCommentPattern: pattern.delivery },
        { type: "review" as const, agentId: qa, approvalCommentPattern: pattern.qa },
      ].map(({ agentId, ...stage }, i) => ({
        ...stage, id: i === 0 ? stageId : randomUUID(), approvalsNeeded: 1 as const,
        participants: [{ id: randomUUID(), ...principal(agentId) }],
      })),
    };
    const executionState = {
      status: "changes_requested" as const,
      currentStageId: stageId,
      currentStageType: "review" as const,
      currentStageIndex: 0,
      currentParticipant: principal(reviewer),
      returnAssignee: principal(implementer),
      completedStageIds: [],
      lastDecisionId: returnDecisionId,
      lastDecisionOutcome: "changes_requested" as const,
      reviewRequest: null,
      monitor: null,
      changesRequestedCount: 1,
    };
    await db.insert(issues).values({
      id: issueId, companyId, projectId, identifier, title: identifier, assigneeAgentId: implementer,
      responsibleUserId: userId, status: "in_progress", statusVersion: 12, executionPolicy, executionState,
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: implementer, issueId, status: "running", responsibleUserId: userId,
      runtimeMode: "legacy", startedAt: new Date(), contextSnapshot: { issueId },
    });
    const [issue] = await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId })
      .where(eq(issues.id, issueId)).returning();
    await db.insert(issueExecutionDecisions).values([randomUUID(), randomUUID(), returnDecisionId].map((id, i) => ({
      id, issueId, companyId, stageId: i === 2 ? stageId : randomUUID(), stageType: "review",
      outcome: "changes_requested", actorAgentId: reviewer, body: "Address the review feedback",
      createdAt: new Date(Date.UTC(2026, 10, 27, 1 + i)),
    })));
    const marker = `pc-resubmit-review: ${identifier} return=${returnDecisionId} sha=${sha}`;
    await db.insert(issueThreadInteractions).values({
      id: ceoInteractionId, companyId, issueId, kind: "ask_user_questions", status: "answered",
      addresseeAgentId: ceo, resolvedByAgentId: ceo,
      idempotencyKey: historical ? `review-ceiling:${issueId}:${returnDecisionId}:${sha}` : null,
      createdAt: new Date("2026-11-27T03:03:00Z"), resolvedAt: new Date("2026-11-27T03:05:00Z"),
      payload: {
        version: 1,
        questions: ["next_route", "quote_for_context"].map((id) => ({
          id, prompt: "Which route?", selectionMode: "single", allowOther: true,
          options: [{ id: "paperclip_text_answer", label: "Type an answer", freeText: true }],
        })),
      },
      result: answer(marker),
    });
    const body = {
      stageId, returnDecisionId, ceoInteractionId, reviewedSha: sha, statusVersion: issue!.statusVersion,
      updatedAt: issue!.updatedAt.toISOString(), comment: `submitted: ${sha} branch=pc/${identifier}\nReview the authorized changes.`,
    };
    const path = `/api/issues/${identifier}/resubmit-execution-review`;
    const authorization = (ownerRun = runId) => `Bearer ${createLocalAgentJwt(implementer, companyId, "process", ownerRun)}`;
    const call = (input = body, auth: string | null = authorization()) => {
      const patch = request(app).patch(path);
      if (auth) patch.set("Authorization", auth);
      return patch.send(input);
    };
    const snapshot = async () => ({
      issue: (await db.select().from(issues).where(eq(issues.id, issueId)))[0],
      decisions: await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, issueId))
        .orderBy(issueExecutionDecisions.id),
      interactions: await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId))
        .orderBy(issueThreadInteractions.id),
      comments: await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)).orderBy(issueComments.id),
      audit: await db.select().from(activityLog).where(eq(activityLog.entityId, issueId)).orderBy(activityLog.id),
      wakes: await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
      )).orderBy(agentWakeupRequests.id),
    });
    const setAnswer = (result: ReturnType<typeof answer>) =>
      db.update(issueThreadInteractions).set({ result }).where(eq(issueThreadInteractions.id, ceoInteractionId));
    const rejectWithoutWrites = async (status: number, code?: string, input = body, auth: string | null = authorization()) => {
      const before = await snapshot();
      const response = await call(input, auth).expect(status);
      if (code) expect(response.body.details?.code ?? response.body.code).toBe(code);
      expect(await snapshot()).toEqual(before);
    };
    return { issueId, identifier, runId, marker, body, path, authorization, call, snapshot, setAnswer, rejectWithoutWrites, executionPolicy };
  }

  it("serializes two submissions and persists the route, evidence, comment, audit and one wake", async () => {
    const f = await fixture();
    const options = await request(app).options(f.path).expect(200);
    expect(options.headers.allow).toContain("PATCH");
    const before = await f.snapshot();
    const body = { ...f.body, comment: f.body.comment.replaceAll("\n", "\r\n") };
    const responses = await Promise.all([f.call(body), f.call(body)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const { body: updated } = responses.find((response) => response.status === 200)!;
    const { stages } = updated.executionPolicy;
    expect(stages.map((stage: typeof stages[number]) => [stage.type, stage.participants[0].agentId, stage.approvalCommentPattern]))
      .toEqual([["review", reviewer, pattern.review], ["delivery", implementer, pattern.delivery], ["review", qa, pattern.qa]]);
    expect(new Set(stages.map((stage: typeof stages[number]) => stage.id)).size).toBe(3);
    for (const stage of stages) {
      expect(f.executionPolicy.stages.some((previous) => previous.id === stage.id)).toBe(false);
    }
    expect(updated).toMatchObject({
      status: "in_review", assigneeAgentId: reviewer, assigneeUserId: null, statusVersion: f.body.statusVersion + 1,
      executionState: {
        status: "pending", currentStageId: stages[0].id, currentStageIndex: 0, currentParticipant: principal(reviewer),
        completedStageIds: [], returnAssignee: principal(implementer), changesRequestedCount: 0,
        lastDecisionId: f.body.returnDecisionId,
      },
    });
    const saved = await f.snapshot();
    expect(saved.decisions).toEqual(before.decisions);
    expect(saved.interactions).toEqual(before.interactions);
    expect(saved.comments).toMatchObject([{ body: f.body.comment, authorAgentId: implementer, createdByRunId: f.runId }]);
    const commentId = saved.comments[0]!.id;
    const evidence = {
      ceoInteractionId: f.body.ceoInteractionId, returnDecisionId: f.body.returnDecisionId,
      stageId: f.body.stageId, reviewStageId: stages[0].id, reviewedSha: sha, commentId,
    };
    expect(saved.audit).toHaveLength(3);
    expect(saved.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorType: "system", action: consumed, details: expect.objectContaining(evidence) }),
      expect.objectContaining({
        actorType: "agent", agentId: implementer, runId: f.runId, action: "issue.updated",
        details: expect.objectContaining({
          changes: expect.objectContaining({ status: { from: "in_progress", to: "in_review" } }),
          source: "comment", executionPolicy: updated.executionPolicy, executionState: updated.executionState,
          reviewResubmission: evidence,
        }),
      }),
      expect.objectContaining({
        actorType: "agent", agentId: implementer, runId: f.runId, action: "issue.comment_added",
        details: expect.objectContaining({ commentId, updated: true }),
      }),
    ]));
    expect(saved.wakes).toMatchObject([{
      agentId: reviewer, status: "deferred_issue_execution", runId: null, reason: "execution_review_requested",
      payload: { commentId, executionStage: { stageId: stages[0].id, wakeRole: "reviewer" } },
    }]);
  });

  it("consumes the interaction even if the HTTP response disappears and the previous snapshot reappears", async () => {
    const f = await fixture();
    const { issue } = await f.snapshot();
    await expect(f.call({ ...f.body, ceoInteractionId: f.body.ceoInteractionId.toUpperCase() })
      .set("x-drop-response", "true")).rejects.toMatchObject({ code: "ECONNRESET" });
    await f.rejectWithoutWrites(409, "issue_review_resubmission_snapshot_changed");
    expect((await f.snapshot()).audit.filter((row) => row.action === consumed)).toHaveLength(1);
    // The receipt survives reconstruction of an old return and a fresh read.
    await db.update(issues).set({
      status: issue!.status, statusVersion: issue!.statusVersion + 2, updatedAt: new Date(),
      assigneeAgentId: implementer, checkoutRunId: f.runId, executionRunId: f.runId,
      executionPolicy: issue!.executionPolicy, executionState: issue!.executionState,
    }).where(eq(issues.id, f.issueId));
    const restored = (await f.snapshot()).issue!;
    await f.rejectWithoutWrites(409, "issue_review_resubmission_already_used", {
      ...f.body, updatedAt: restored.updatedAt.toISOString(), statusVersion: restored.statusVersion,
    });
  });

  it("rolls back the receipt, wake, comment and route when the final activity write fails", async () => {
    const f = await fixture();
    await db.execute(sql`
      create function reject_review_resubmission_activity() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from activity_log where entity_id = new.entity_id
          and action = 'issue.review_resubmission_consumed')
        and exists (select 1 from agent_wakeup_requests where payload->>'issueId' = new.entity_id)
        then raise exception 'Failure after the wake and consumption receipt are saved';
        end if;
        return new;
      end
      $$
    `);
    await db.execute(sql`
      create trigger reject_review_resubmission_activity before insert on activity_log
      for each row when (new.action = 'issue.comment_added') execute function reject_review_resubmission_activity()
    `);
    try {
      await f.rejectWithoutWrites(500);
    } finally {
      await db.execute(sql`drop trigger reject_review_resubmission_activity on activity_log`);
      await db.execute(sql`drop function reject_review_resubmission_activity()`);
    }
    await f.call().expect(200);
  });

  it("rejects stale or insufficient returns and snapshots without writes", async () => {
    const f = await fixture();
    const stale = "issue_review_resubmission_snapshot_changed";
    await f.rejectWithoutWrites(409, stale, { ...f.body, stageId: randomUUID() });
    await f.rejectWithoutWrites(409, stale, { ...f.body, returnDecisionId: randomUUID() });
    await f.rejectWithoutWrites(409, stale, { ...f.body, statusVersion: f.body.statusVersion - 1 });
    await f.rejectWithoutWrites(409, stale, { ...f.body, updatedAt: "2026-01-01T00:00:00.000Z" });

    const history = (await f.snapshot()).decisions;
    await db.delete(issueExecutionDecisions).where(eq(issueExecutionDecisions.id,
      history.find((row) => row.id !== f.body.returnDecisionId)!.id));
    await f.rejectWithoutWrites(409, "issue_review_resubmission_below_ceiling");
    await db.insert(issueExecutionDecisions).values({
      companyId, issueId: f.issueId, stageId: f.body.stageId, stageType: "review",
      outcome: "approved", actorAgentId: reviewer, body: "A newer decision",
    });
    await f.rejectWithoutWrites(409, stale);
    await db.insert(issueExecutionDecisions).values({
      companyId, issueId: f.issueId, stageId: f.body.stageId, stageType: "review",
      outcome: "changes_requested", actorAgentId: reviewer, body: "A newer return",
    });
    await f.rejectWithoutWrites(409, stale);
  });

  it("checks the answered CEO question, exact SHA, same task and comment evidence", async () => {
    const f = await fixture();
    const other = await fixture();
    const missing = "issue_review_resubmission_ceo_response_required";
    await f.rejectWithoutWrites(403, missing, { ...f.body, ceoInteractionId: other.body.ceoInteractionId });
    await f.rejectWithoutWrites(403, missing, { ...f.body, reviewedSha: "8".repeat(40) });
    await f.setAnswer({
      version: 1,
      answers: [...answer("Declined").answers, ...answer(f.marker, "quote_for_context").answers],
    });
    await f.rejectWithoutWrites(403, missing);
    await f.setAnswer(answer(`${f.marker}\nDecision declined.`));
    await f.rejectWithoutWrites(403, missing);
    await f.setAnswer(answer(f.marker));
    await db.update(issueThreadInteractions).set({ status: "pending" }).where(eq(issueThreadInteractions.id, f.body.ceoInteractionId));
    await f.rejectWithoutWrites(403, missing);
    await db.update(issueThreadInteractions).set({ status: "answered", resolvedByAgentId: reviewer })
      .where(eq(issueThreadInteractions.id, f.body.ceoInteractionId));
    await f.rejectWithoutWrites(403, missing);
    await db.update(issueThreadInteractions).set({ resolvedByAgentId: ceo })
      .where(eq(issueThreadInteractions.id, f.body.ceoInteractionId));
    await f.rejectWithoutWrites(422, "issue_review_resubmission_comment_mismatch", {
      ...f.body, comment: `submitted: ${sha} branch=pc/${other.identifier}`,
    });
    await f.call().expect(200);
  });

  it("requires the stored historical permission text on its exact interaction", async () => {
    const f = await fixture(true);
    await f.setAnswer(answer("Отказываю в новом проходе."));
    await f.rejectWithoutWrites(403, "issue_review_resubmission_ceo_response_required");
    await f.setAnswer(answer(f.marker));
    await f.rejectWithoutWrites(403, "issue_review_resubmission_ceo_response_required");
    await f.setAnswer(answer(
      "Разрешаю один повторный проход LEA-2049 для опубликованного SHA 395d90eb3a4afc6aee4339cf03df13962ce51354 после возврата af456ebd-4a00-4a1c-9eb3-2499ca84c79c. Маршрут — review (Architect) → delivery → QA. Архитектор проверяет весь сдаваемый SHA и отдельно регрессии LEA-2095, LEA-2096 и LEA-2097. Доставка начинается после его одобрения, затем проходит QA.\n\nДопуск действует один раз.",
    ));
    await f.rejectWithoutWrites(403, "issue_review_resubmission_ceo_response_required", { ...f.body, reviewedSha: "a".repeat(40) });
    await db.update(issueThreadInteractions).set({ idempotencyKey: null })
      .where(eq(issueThreadInteractions.id, f.body.ceoInteractionId));
    await f.rejectWithoutWrites(403, "issue_review_resubmission_ceo_response_required");
    await db.update(issueThreadInteractions)
      .set({ idempotencyKey: `review-ceiling:${f.issueId}:${f.body.returnDecisionId}:${sha}` })
      .where(eq(issueThreadInteractions.id, f.body.ceoInteractionId));
    await f.call().expect(200);
  });

  it("rejects board auth, another run, and a Stop committed before run termination", async () => {
    const f = await fixture();
    await f.rejectWithoutWrites(403, undefined, f.body, null);
    const otherRun = randomUUID();
    await db.insert(heartbeatRuns).values({ id: otherRun, companyId, agentId: implementer, issueId: f.issueId, status: "running" });
    await f.rejectWithoutWrites(409, "issue_review_resubmission_run_not_owner", f.body, f.authorization(otherRun));
    const other = await fixture();
    await db.update(issues).set({ executionRunId: other.runId, checkoutRunId: other.runId }).where(eq(issues.id, f.issueId));
    await f.rejectWithoutWrites(409, "issue_review_resubmission_run_not_owner", f.body, f.authorization(other.runId));
    await db.update(issues).set({ executionRunId: f.runId, checkoutRunId: f.runId }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ resultJson: { startupCancellation: { budgetEnforcement: {} } } })
      .where(eq(heartbeatRuns.id, f.runId));
    await f.rejectWithoutWrites(403, "agent_run_cancelled");
  });

  it("requires the active Fullstack role and the Cards project", async () => {
    const f = await fixture();
    await db.update(agents).set({ name: "Engineer" }).where(eq(agents.id, implementer));
    try {
      await f.rejectWithoutWrites(403);
    } finally {
      await db.update(agents).set({ name: "Fullstack Engineer" }).where(eq(agents.id, implementer));
    }
    await db.update(issues).set({ projectId: null }).where(eq(issues.id, f.issueId));
    await f.rejectWithoutWrites(403);
  });

  it("rejects an open blocker and a done blocker being reopened under a source lock", async () => {
    const f = await fixture();
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId, projectId, title: "Review defect", status: "todo" });
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: f.issueId, type: "blocks" });
    await f.rejectWithoutWrites(409, "issue_review_resubmission_unresolved_blockers");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));
    await db.transaction(async (tx) => {
      await tx.update(issues).set({ status: "todo" }).where(eq(issues.id, blockerId));
      await f.rejectWithoutWrites(409, "issue_review_resubmission_snapshot_changed");
    });
    await f.rejectWithoutWrites(409, "issue_review_resubmission_unresolved_blockers");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));
    await f.call().expect(200);
  });

  it("recovers one original Architect wake after queue delivery fails and the worker restarts", async () => {
    const f = await fixture();
    const { body: updated } = await f.call().expect(200);
    const saved = await f.snapshot();
    const [wake] = saved.wakes;
    expect(saved.wakes).toHaveLength(1);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, reviewer));
    const [busy] = await db.insert(heartbeatRuns).values({
      companyId, agentId: reviewer, responsibleUserId: userId, status: "running", startedAt: new Date(),
    }).returning();
    await db.execute(sql`
      create function fail_review_resubmission_delivery() returns trigger language plpgsql as $$
      begin
        raise exception 'Delivery unavailable before promoting the review wake';
      end
      $$
    `);
    await db.execute(sql`
      create trigger fail_review_resubmission_delivery before update on agent_wakeup_requests
      for each row when (old.reason = 'execution_review_requested' and old.status = 'deferred_issue_execution')
      execute function fail_review_resubmission_delivery()
    `);
    const failedDb = createDb(temporary.connectionString);
    try {
      await expect(heartbeatService(failedDb).resumeQueuedRuns()).rejects.toMatchObject({
        cause: { message: "Delivery unavailable before promoting the review wake" },
      });
      expect((await f.snapshot()).wakes).toEqual(saved.wakes);
    } finally {
      await failedDb.$client.end();
      await db.execute(sql`drop trigger fail_review_resubmission_delivery on agent_wakeup_requests`);
      await db.execute(sql`drop function fail_review_resubmission_delivery()`);
    }

    const restartedDb = createDb(temporary.connectionString);
    try {
      const heartbeat = heartbeatService(restartedDb);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.resumeQueuedRuns();
      const runs = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.agentId, reviewer),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`,
      ));
      const commentId = saved.comments[0]!.id;
      expect(runs).toMatchObject([{
        status: "queued", wakeupRequestId: wake!.id,
        contextSnapshot: {
          issueId: f.issueId, commentId, wakeReason: "execution_review_requested",
          executionStage: { stageId: updated.executionState.currentStageId, wakeRole: "reviewer" },
        },
      }]);
      expect((await f.snapshot()).wakes).toMatchObject([{ id: wake!.id, runId: runs[0]!.id }]);
    } finally {
      await restartedDb.$client.end();
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy!.id));
    }
  });
});
