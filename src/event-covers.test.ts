import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isAllowedCoverImageType,
  isOwnedCoverImageKey,
  matchesImageSignature,
} from "./event-covers.js";

describe("event cover uploads", () => {
  it("accepts only supported image content types", () => {
    assert.equal(isAllowedCoverImageType("image/jpeg"), true);
    assert.equal(isAllowedCoverImageType("image/png"), true);
    assert.equal(isAllowedCoverImageType("image/webp"), true);
    assert.equal(isAllowedCoverImageType("image/svg+xml"), false);
    assert.equal(isAllowedCoverImageType("text/html"), false);
  });

  it("checks file signatures instead of trusting the declared type", () => {
    assert.equal(
      matchesImageSignature(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg"),
      true,
    );
    assert.equal(
      matchesImageSignature(new Uint8Array([0xff, 0xd8, 0xff]), "image/png"),
      false,
    );
    assert.equal(
      matchesImageSignature(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/png",
      ),
      true,
    );
    assert.equal(
      matchesImageSignature(new Uint8Array(12), "image/webp"),
      false,
    );
  });

  it("rejects object keys outside the uploading account prefix", () => {
    const key = "owner-1/123e4567-e89b-12d3-a456-426614174000.jpg";
    assert.equal(isOwnedCoverImageKey(key, "owner-1"), true);
    assert.equal(isOwnedCoverImageKey(key, "owner-2"), false);
    assert.equal(
      isOwnedCoverImageKey("owner-1/../private.jpg", "owner-1"),
      false,
    );
  });
});
