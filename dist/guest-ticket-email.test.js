"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const guest_ticket_email_js_1 = require("./guest-ticket-email.js");
(0, node_test_1.test)("guest email links use public HTTPS and keep the ticket token out of request URLs", () => {
    for (const origin of [undefined, "http://example.test", "https://localhost", "https://user:password@example.test", "https://example.test/?token=x"]) {
        strict_1.default.throws(() => (0, guest_ticket_email_js_1.guestTicketLink)(origin, "secret-token"));
    }
    const link = new URL((0, guest_ticket_email_js_1.guestTicketLink)("https://tickets.example.test/", "secret-token"));
    strict_1.default.equal(link.pathname, "/guest-ticket");
    strict_1.default.equal(link.search, "");
    strict_1.default.equal(new URLSearchParams(link.hash.slice(1)).get("token"), "secret-token");
});
(0, node_test_1.test)("guest emails escape names and event details without making the email an entry action", () => {
    const html = (0, guest_ticket_email_js_1.guestTicketEmail)({ guestName: '<img src=x onerror="alert(1)">', event: "A & B", venue: "<script>venue</script>",
        startsAt: new Date("2099-01-01T18:00:00Z"), tableNumber: 1, seatNumber: 2, ticketType: "Dinner" }, "https://tickets.example.test/guest-ticket#token=test");
    strict_1.default.ok(!html.includes("<script>"));
    strict_1.default.ok(!html.includes("<img"));
    strict_1.default.match(html, /A &amp; B/);
    strict_1.default.match(html, /No account or app is needed/);
    strict_1.default.match(html, /Table 1 · Seat 2/);
    strict_1.default.match(html, /attached to this email as a PNG image/);
    strict_1.default.match(html, /previous QR code stops working, including any downloaded copy/);
});
(0, node_test_1.test)("guest QR attachments are portable PNGs with seat-specific names and a white quiet zone", async () => {
    const attachment = await (0, guest_ticket_email_js_1.guestTicketAttachment)("current-private-guest-token", { tableNumber: 3, seatNumber: 2 });
    strict_1.default.equal(attachment.name, "guest-ticket-table-3-seat-2.png");
    strict_1.default.ok(!attachment.name.includes("current-private-guest-token"));
    strict_1.default.ok(!attachment.content.startsWith("data:"), "Brevo expects raw base64 content");
    const png = Buffer.from(attachment.content, "base64");
    strict_1.default.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    strict_1.default.equal(png.toString("ascii", 12, 16), "IHDR");
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    strict_1.default.equal(width, height);
    strict_1.default.ok(width >= 290, "attachment must be large enough to scan without enlarging");
    strict_1.default.ok(png.length < 100_000, "individual QR attachment stays small for email clients");
});
(0, node_test_1.test)("local guest links require explicit development mode and never allow public HTTP", () => {
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173", "http://172.20.10.3:5173", "http://192.168.1.5:5173", "http://10.0.0.2:5173"]) {
        strict_1.default.throws(() => (0, guest_ticket_email_js_1.guestTicketLink)(origin, "ticket-token"));
        const link = new URL((0, guest_ticket_email_js_1.guestTicketLink)(origin, "ticket-token", { allowDevelopmentUrls: true }));
        strict_1.default.equal(link.origin, origin);
        strict_1.default.equal(link.pathname, "/guest-ticket");
        strict_1.default.equal(new URLSearchParams(link.hash.slice(1)).get("token"), "ticket-token");
    }
    for (const origin of ["http://example.com", "http://172.32.0.1", "http://10.example.com", "ftp://localhost", "http://user:pass@localhost:5173"]) {
        strict_1.default.throws(() => (0, guest_ticket_email_js_1.guestTicketLink)(origin, "ticket-token", { allowDevelopmentUrls: true }));
    }
});
