"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canTransitionCheckIn = canTransitionCheckIn;
function canTransitionCheckIn(action, checkedInAt, checkedOutAt) {
    const currentlyInside = checkedInAt !== null && checkedOutAt === null;
    return action === "CHECK_IN" ? !currentlyInside : currentlyInside;
}
