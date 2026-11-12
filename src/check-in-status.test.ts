import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canTransitionCheckIn } from "./check-in-status.js";

describe("ticket entry transitions", () => {
  it("allows entry for an unused or checked-out ticket", () => {
    assert.equal(canTransitionCheckIn("CHECK_IN", null, null), true);
    assert.equal(
      canTransitionCheckIn("CHECK_IN", new Date(), new Date()),
      true,
    );
  });

  it("rejects duplicate entry and checkout outside an active visit", () => {
    assert.equal(canTransitionCheckIn("CHECK_IN", new Date(), null), false);
    assert.equal(canTransitionCheckIn("CHECK_OUT", null, null), false);
    assert.equal(
      canTransitionCheckIn("CHECK_OUT", new Date(), new Date()),
      false,
    );
  });

  it("allows checkout only during an active visit", () => {
    assert.equal(canTransitionCheckIn("CHECK_OUT", new Date(), null), true);
  });
});
