"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const cover_storage_error_js_1 = require("./cover-storage-error.js");
(0, node_test_1.it)("reports denied S3 reads as a storage configuration failure, not an invalid image", () => {
    const log = node_test_1.mock.method(console, "error", () => { });
    try {
        // HeadObject can return an unnamed 403; GetObject identifies AccessDenied.
        for (const name of ["Unknown", "AccessDenied"]) {
            strict_1.default.throws(() => (0, cover_storage_error_js_1.coverVerificationFailure)({ name, $metadata: { httpStatusCode: 403 } }), (error) => error instanceof cover_storage_error_js_1.CoverStorageError && error.status === 502 && /S3 read permissions/.test(error.message));
        }
        strict_1.default.equal(log.mock.callCount(), 2);
    }
    finally {
        log.mock.restore();
    }
});
(0, node_test_1.it)("keeps missing images eligible for re-upload", () => {
    strict_1.default.equal((0, cover_storage_error_js_1.coverVerificationFailure)({ name: "NoSuchKey" }), false);
    strict_1.default.equal((0, cover_storage_error_js_1.coverVerificationFailure)({ name: "NotFound" }), false);
    strict_1.default.equal((0, cover_storage_error_js_1.coverVerificationFailure)({ $metadata: { httpStatusCode: 404 } }), false);
});
(0, node_test_1.it)("reports transient failures without leaking storage credentials or raw errors", () => {
    const log = node_test_1.mock.method(console, "error", () => { });
    try {
        strict_1.default.throws(() => (0, cover_storage_error_js_1.coverVerificationFailure)({ name: "TimeoutError", message: "private diagnostic data" }), (error) => error instanceof cover_storage_error_js_1.CoverStorageError && /temporarily unavailable/.test(error.message));
        strict_1.default.doesNotMatch(JSON.stringify(log.mock.calls), /private diagnostic data/);
    }
    finally {
        log.mock.restore();
    }
});
