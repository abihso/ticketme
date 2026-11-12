"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const refund_status_js_1 = require("./refund-status.js");
(0, node_test_1.describe)("refund review transitions", () => {
    (0, node_test_1.it)("allows a decision only while a request is pending", () => {
        strict_1.default.equal((0, refund_status_js_1.canReviewRefundStatus)("PENDING"), true);
        strict_1.default.equal((0, refund_status_js_1.canReviewRefundStatus)("APPROVED"), false);
        strict_1.default.equal((0, refund_status_js_1.canReviewRefundStatus)("REJECTED"), false);
        strict_1.default.equal((0, refund_status_js_1.canReviewRefundStatus)("PROCESSED"), false);
    });
});
