import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Fork (Cards): review remarks must always have an owner, and a reviewer's
// return with remarks filed as blockers must land instead of killing the
// reviewer's run (LEA-1861, LEA-1883, LEA-1889…1897).
describeEmbeddedPostgres("review remark ownership routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const enqueueWakeup = vi.fn(async (_agentId: string, _options: unknown) => ({ id: randomUUID() }));

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-remark-ownership-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    enqueueWakeup.mockClear();
    // Routes finish hand-off wakes after responding; let them land before cleanup.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await db.execute(sql`truncate table companies cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    const reviewerAgentId = randomUUID();
    const implementerAgentId = randomUUID();
    const memberUserId = `${prefix.toLowerCase()}-member`;
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([reviewerAgentId, implementerAgentId].map((id, index) => ({
      id,
      companyId,
      name: index === 0 ? `${prefix} Reviewer` : `${prefix} Implementer`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })));
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: memberUserId,
      status: "active",
      membershipRole: "operator",
    });
    return { companyId, reviewerAgentId, implementerAgentId, memberUserId };
  }

  async function seedIssue(companyId: string, identifier: string, values: Partial<typeof issues.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      identifier,
      title: identifier,
      status: "todo",
      priority: "medium",
      ...values,
    });
    return id;
  }

  async function seedReviewStage(seeded: Awaited<ReturnType<typeof seedCompany>>, identifier: string) {
    const stageId = randomUUID();
    const issueId = await seedIssue(seeded.companyId, identifier, {
      status: "in_review",
      assigneeAgentId: seeded.reviewerAgentId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: seeded.reviewerAgentId }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: seeded.reviewerAgentId },
        returnAssignee: { type: "agent", agentId: seeded.implementerAgentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    const runId = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    return { issueId, runId };
  }

  async function seedRun(companyId: string, agentId: string, issueId: string | null) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: issueId ? { issueId, wakeReason: "execution_review_requested" } : {},
    });
    return runId;
  }

  async function block(companyId: string, blockerId: string, blockedId: string) {
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });
  }

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {
      stalledReviewDecisionEnqueueWakeup: enqueueWakeup as any,
    }));
    testApp.use(errorHandler);
    return testApp;
  }

  function agentActor(companyId: string, agentId: string, runId = randomUUID()) {
    return { type: "agent", source: "agent_key", companyId, agentId, runId };
  }

  it("hands a return with an open remark blocker back to the implementer as blocked", async () => {
    const seeded = await seedCompany("RRB");
    const { issueId, runId } = await seedReviewStage(seeded, "RRB-101");
    const remarkId = await seedIssue(seeded.companyId, "RRB-102", { assigneeAgentId: seeded.implementerAgentId });
    await block(seeded.companyId, remarkId, issueId);

    const res = await request(app(agentActor(seeded.companyId, seeded.reviewerAgentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", comment: "Remark RRB-2 filed as a blocker." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(stored.status).toBe("blocked");
    expect(stored.assigneeAgentId).toBe(seeded.implementerAgentId);
    expect(stored.executionState).toMatchObject({ lastDecisionOutcome: "changes_requested" });
    const relations = await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, issueId));
    expect(relations.map((relation) => relation.issueId)).toEqual([remarkId]);
  });

  it("keeps an ordinary return without blockers in progress", async () => {
    const seeded = await seedCompany("RRP");
    const { issueId, runId } = await seedReviewStage(seeded, "RRP-101");

    const res = await request(app(agentActor(seeded.companyId, seeded.reviewerAgentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", comment: "Fix the naming in the comment." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(stored.status).toBe("in_progress");
    expect(stored.assigneeAgentId).toBe(seeded.implementerAgentId);
    // The implementer's wake lands after the response; let it settle before cleanup.
    await vi.waitFor(async () => {
      const wakes = await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, seeded.implementerAgentId));
      expect(wakes.length).toBeGreaterThan(0);
    }, { timeout: 10_000 });
  });

  it("refuses an in_progress hand-off over open blockers before stopping the caller's run", async () => {
    const seeded = await seedCompany("RHO");
    const issueId = await seedIssue(seeded.companyId, "RHO-101", {
      status: "in_progress",
      assigneeAgentId: seeded.reviewerAgentId,
    });
    const runId = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    const blockerId = await seedIssue(seeded.companyId, "RHO-102", { assigneeAgentId: seeded.implementerAgentId });
    await block(seeded.companyId, blockerId, issueId);

    const res = await request(app(agentActor(seeded.companyId, seeded.reviewerAgentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", assigneeAgentId: seeded.implementerAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ unresolvedBlockerIssueIds: [blockerId] });
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
    expect(run.status).toBe("running");
  });

  it("refuses a parent blocker filed by an agent without an owner or in backlog", async () => {
    const seeded = await seedCompany("RCB");
    const parentId = await seedIssue(seeded.companyId, "RCB-101", {
      status: "in_review",
      assigneeAgentId: seeded.reviewerAgentId,
    });
    const reviewerRunId = await seedRun(seeded.companyId, seeded.reviewerAgentId, parentId);
    const reviewer = app(agentActor(seeded.companyId, seeded.reviewerAgentId, reviewerRunId));

    const unassigned = await request(reviewer).post(`/api/issues/${parentId}/children`)
      .send({ title: "Remark without owner", status: "todo", blockParentUntilDone: true });
    expect(unassigned.status, JSON.stringify(unassigned.body)).toBe(422);
    expect(unassigned.body.details).toMatchObject({ code: "blocker_without_owner" });

    const deferred = await request(reviewer).post(`/api/issues/${parentId}/children`)
      .send({
        title: "Remark parked in backlog",
        status: "backlog",
        assigneeAgentId: seeded.implementerAgentId,
        blockParentUntilDone: true,
      });
    expect(deferred.status, JSON.stringify(deferred.body)).toBe(422);
    expect(deferred.body.details).toMatchObject({ code: "blocker_without_owner" });

    const children = await db.select().from(issues).where(eq(issues.parentId, parentId));
    expect(children).toEqual([]);
  });

  it("lets a reviewer file a remark for the author of the work under review", async () => {
    const seeded = await seedCompany("RDC");
    const { issueId, runId } = await seedReviewStage(seeded, "RDC-101");
    // The implementer authored the reviewed issue: a plain delegation back is a cycle.
    await db.update(issues).set({ createdByAgentId: seeded.implementerAgentId }).where(eq(issues.id, issueId));
    const reviewer = app(agentActor(seeded.companyId, seeded.reviewerAgentId, runId));

    // Backlog keeps the assignment wake out of this harness; the cycle check runs the same.
    const remark = await request(reviewer).post(`/api/issues/${issueId}/children`)
      .send({ title: "Remark for the author", status: "backlog", assigneeAgentId: seeded.implementerAgentId });
    expect(remark.status, JSON.stringify(remark.body)).toBe(201);
    expect(remark.body).toMatchObject({ assigneeAgentId: seeded.implementerAgentId });

    // Outside a review stage the cycle guard still holds.
    await db.update(issues).set({ executionState: null }).where(eq(issues.id, issueId));
    const cycle = await request(reviewer).post(`/api/issues/${issueId}/children`)
      .send({ title: "Delegation back", status: "backlog", assigneeAgentId: seeded.implementerAgentId });
    expect(cycle.status, JSON.stringify(cycle.body)).toBe(409);
    expect(cycle.body.error).not.toContain("unassigned");
  });

  it("refuses an unassigned todo from an agent and keeps backlog deferral", async () => {
    const seeded = await seedCompany("RTD");
    const author = app(agentActor(seeded.companyId, seeded.reviewerAgentId,
      await seedRun(seeded.companyId, seeded.reviewerAgentId, null)));

    const todo = await request(author).post(`/api/companies/${seeded.companyId}/issues`)
      .send({ title: "Follow-up nobody owns", status: "todo" });
    expect(todo.status, JSON.stringify(todo.body)).toBe(422);
    expect(todo.body.details).toMatchObject({ code: "issue_without_owner" });

    const deferred = await request(author).post(`/api/companies/${seeded.companyId}/issues`)
      .send({ title: "Deferred until the flag ships", status: "backlog" });
    expect(deferred.status, JSON.stringify(deferred.body)).toBe(201);
    expect(deferred.body).toMatchObject({ status: "backlog", assigneeAgentId: null });
  });

  it("refuses linking an ownerless open blocker by an agent", async () => {
    const seeded = await seedCompany("RLB");
    const issueId = await seedIssue(seeded.companyId, "RLB-101", {
      status: "in_review",
      assigneeAgentId: seeded.reviewerAgentId,
    });
    const runId = await seedRun(seeded.companyId, seeded.reviewerAgentId, issueId);
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    const ownerlessId = await seedIssue(seeded.companyId, "RLB-102", { status: "backlog" });

    const res = await request(app(agentActor(seeded.companyId, seeded.reviewerAgentId, runId)))
      .patch(`/api/issues/${issueId}`)
      .send({ blockedByIssueIds: [ownerlessId] });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ code: "blocker_without_owner", issueIds: [ownerlessId] });
    const relations = await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, issueId));
    expect(relations).toEqual([]);
  });
});
