import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canReviewRefundStatus } from "./refund-status.js";

describe("refund review transitions", () => {
  it("allows a decision only while a request is pending", () => {
    assert.equal(canReviewRefundStatus("PENDING"), true);
    assert.equal(canReviewRefundStatus("APPROVED"), false);
    assert.equal(canReviewRefundStatus("REJECTED"), false);
    assert.equal(canReviewRefundStatus("PROCESSED"), false);
  });
});
