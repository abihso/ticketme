"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const event_covers_js_1 = require("./event-covers.js");
(0, node_test_1.describe)("event cover uploads", () => {
    (0, node_test_1.it)("accepts only supported image content types", () => {
        strict_1.default.equal((0, event_covers_js_1.isAllowedCoverImageType)("image/jpeg"), true);
        strict_1.default.equal((0, event_covers_js_1.isAllowedCoverImageType)("image/png"), true);
        strict_1.default.equal((0, event_covers_js_1.isAllowedCoverImageType)("image/webp"), true);
        strict_1.default.equal((0, event_covers_js_1.isAllowedCoverImageType)("image/svg+xml"), false);
        strict_1.default.equal((0, event_covers_js_1.isAllowedCoverImageType)("text/html"), false);
    });
    (0, node_test_1.it)("checks file signatures instead of trusting the declared type", () => {
        strict_1.default.equal((0, event_covers_js_1.matchesImageSignature)(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg"), true);
        strict_1.default.equal((0, event_covers_js_1.matchesImageSignature)(new Uint8Array([0xff, 0xd8, 0xff]), "image/png"), false);
        strict_1.default.equal((0, event_covers_js_1.matchesImageSignature)(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"), true);
        strict_1.default.equal((0, event_covers_js_1.matchesImageSignature)(new Uint8Array(12), "image/webp"), false);
    });
    (0, node_test_1.it)("rejects object keys outside the uploading account prefix", () => {
        const key = "owner-1/123e4567-e89b-12d3-a456-426614174000.jpg";
        strict_1.default.equal((0, event_covers_js_1.isOwnedCoverImageKey)(key, "owner-1"), true);
        strict_1.default.equal((0, event_covers_js_1.isOwnedCoverImageKey)(key, "owner-2"), false);
        strict_1.default.equal((0, event_covers_js_1.isOwnedCoverImageKey)("owner-1/../private.jpg", "owner-1"), false);
    });
});
