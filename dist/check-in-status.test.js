"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const check_in_status_js_1 = require("./check-in-status.js");
(0, node_test_1.describe)("ticket entry transitions", () => {
    (0, node_test_1.it)("allows entry for an unused or checked-out ticket", () => {
        strict_1.default.equal((0, check_in_status_js_1.canTransitionCheckIn)("CHECK_IN", null, null), true);
        strict_1.default.equal((0, check_in_status_js_1.canTransitionCheckIn)("CHECK_IN", new Date(), new Date()), true);
    });
    (0, node_test_1.it)("rejects duplicate entry and checkout outside an active visit", () => {
        strict_1.default.equal((0, check_in_status_js_1.canTransitionCheckIn)("CHECK_IN", new Date(), null), false);
        strict_1.default.equal((0, check_in_status_js_1.canTransitionCheckIn)("CHECK_OUT", null, null), false);
        strict_1.default.equal((0, check_in_status_js_1.canTransitionCheckIn)("CHECK_OUT", new Date(), new Date()), false);
    });
    (0, node_test_1.it)("allows checkout only during an active visit", () => {
        strict_1.default.equal((0, check_in_status_js_1.canTransitionCheckIn)("CHECK_OUT", new Date(), null), true);
    });
});
