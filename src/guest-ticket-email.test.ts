import assert from "node:assert/strict";
import { test } from "node:test";
import { guestTicketEmail, guestTicketLink } from "./guest-ticket-email.js";

test("guest email links use public HTTPS and keep the ticket token out of request URLs", () => {
  for (const origin of [undefined, "http://example.test", "https://localhost", "https://user:password@example.test", "https://example.test/?token=x"]) {
    assert.throws(() => guestTicketLink(origin, "secret-token"));
  }
  const link = new URL(guestTicketLink("https://tickets.example.test/", "secret-token"));
  assert.equal(link.pathname, "/guest-ticket");
  assert.equal(link.search, "");
  assert.equal(new URLSearchParams(link.hash.slice(1)).get("token"), "secret-token");
});

test("guest emails escape names and event details without making the email an entry action", () => {
  const html = guestTicketEmail({ guestName: '<img src=x onerror="alert(1)">', event: "A & B", venue: "<script>venue</script>",
    startsAt: new Date("2099-01-01T18:00:00Z"), tableNumber: 1, seatNumber: 2, ticketType: "Dinner" },
    "https://tickets.example.test/guest-ticket#token=test");
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.match(html, /A &amp; B/);
  assert.match(html, /No account or app is needed/);
  assert.match(html, /Table 1 · Seat 2/);
});


test("local guest links require explicit development mode and never allow public HTTP", () => {
  for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173", "http://172.20.10.3:5173", "http://192.168.1.5:5173", "http://10.0.0.2:5173"]) {
    assert.throws(() => guestTicketLink(origin, "ticket-token"));
    const link = new URL(guestTicketLink(origin, "ticket-token", { allowDevelopmentUrls: true }));
    assert.equal(link.origin, origin);
    assert.equal(link.pathname, "/guest-ticket");
    assert.equal(new URLSearchParams(link.hash.slice(1)).get("token"), "ticket-token");
  }
  for (const origin of ["http://example.com", "http://172.32.0.1", "http://10.example.com", "ftp://localhost", "http://user:pass@localhost:5173"]) {
    assert.throws(() => guestTicketLink(origin, "ticket-token", { allowDevelopmentUrls: true }));
  }
});
