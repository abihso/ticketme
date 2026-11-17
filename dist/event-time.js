"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasEventEnded = hasEventEnded;
function hasEventEnded(event, now = Date.now()) {
    return (event.endsAt ?? event.startsAt).getTime() <= now;
}
