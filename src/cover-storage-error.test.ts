import assert from "node:assert/strict";
import { it, mock } from "node:test";
import { CoverStorageError, coverVerificationFailure } from "./cover-storage-error.js";

it("reports denied S3 reads as a storage configuration failure, not an invalid image", () => {
  const log = mock.method(console, "error", () => {});
  try {
    // HeadObject can return an unnamed 403; GetObject identifies AccessDenied.
    for (const name of ["Unknown", "AccessDenied"]) {
      assert.throws(() => coverVerificationFailure({ name, $metadata: { httpStatusCode: 403 } }),
        (error: unknown) => error instanceof CoverStorageError && error.status === 502 && /S3 read permissions/.test(error.message));
    }
    assert.equal(log.mock.callCount(), 2);
  } finally { log.mock.restore(); }
});

it("keeps missing images eligible for re-upload", () => {
  assert.equal(coverVerificationFailure({ name: "NoSuchKey" }), false);
  assert.equal(coverVerificationFailure({ name: "NotFound" }), false);
  assert.equal(coverVerificationFailure({ $metadata: { httpStatusCode: 404 } }), false);
});

it("reports transient failures without leaking storage credentials or raw errors", () => {
  const log = mock.method(console, "error", () => {});
  try {
    assert.throws(() => coverVerificationFailure({ name: "TimeoutError", message: "private diagnostic data" }),
      (error: unknown) => error instanceof CoverStorageError && /temporarily unavailable/.test(error.message));
    assert.doesNotMatch(JSON.stringify(log.mock.calls), /private diagnostic data/);
  } finally { log.mock.restore(); }
});
