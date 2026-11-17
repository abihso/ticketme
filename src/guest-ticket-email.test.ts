import assert from "node:assert/strict";
import { test } from "node:test";
import { guestTicketEmail, guestTicketLink, guestTicketAttachment } from "./guest-ticket-email.js";

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
  assert.match(html, /attached to this email as a PNG image/);
  assert.match(html, /previous QR code stops working, including any downloaded copy/);
});

test("guest QR attachments are portable PNGs with seat-specific names and a white quiet zone", async () => {
  const attachment = await guestTicketAttachment("current-private-guest-token", { tableNumber: 3, seatNumber: 2 });
  assert.equal(attachment.name, "guest-ticket-table-3-seat-2.png");
  assert.ok(!attachment.name.includes("current-private-guest-token"));
  assert.ok(!attachment.content.startsWith("data:"), "Brevo expects raw base64 content");
  const png = Buffer.from(attachment.content, "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.toString("ascii", 12, 16), "IHDR");
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.equal(width, height);
  assert.ok(width >= 290, "attachment must be large enough to scan without enlarging");
  assert.ok(png.length < 100_000, "individual QR attachment stays small for email clients");
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
