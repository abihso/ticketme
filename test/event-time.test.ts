import assert from "node:assert/strict";
import { test } from "node:test";
import { hasEventEnded as serverEnded } from "../src/event-time.js";

const now = Date.parse("2026-11-17T23:00:00Z");
const cases = [
  ["future event", "2026-11-18T00:00:00Z", null, false],
  ["overnight event still running", "2026-11-17T20:00:00Z", "2026-11-18T02:00:00Z", false],
  ["exact end time", "2026-11-17T20:00:00Z", "2026-11-17T23:00:00Z", true],
  ["ended event", "2026-11-16T20:00:00Z", "2026-11-17T02:00:00Z", true],
  ["missing end falls back to start", "2026-11-17T23:00:00Z", null, true],
  ["timezone offset", "2026-11-17T20:00:00+02:00", "2026-11-18T01:00:00+02:00", true],
] as const;
for (const [name, startsAt, endsAt, expected] of cases) {
  test(name, () => {
    assert.equal(serverEnded({ startsAt: new Date(startsAt), endsAt: endsAt ? new Date(endsAt) : null }, now), expected);
  });
}
