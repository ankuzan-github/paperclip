import { describe, expect, it } from "vitest";
import { shouldRequireIssueCommentForWake } from "../services/heartbeat/queue.js";

describe("execution delivery wake (LEA-1570 F1)", () => {
  it("requires an issue comment from a delivery wake like any other stage wake", () => {
    for (const wakeReason of ["execution_review_requested", "execution_approval_requested", "execution_delivery_requested"]) {
      expect(shouldRequireIssueCommentForWake({ wakeReason })).toBe(true);
    }
  });
});
