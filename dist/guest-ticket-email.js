"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.guestTicketLink = guestTicketLink;
exports.guestTicketEmail = guestTicketEmail;
function escapeHtml(value) {
    return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
function guestTicketLink(origin, token, options = {}) {
    if (!origin)
        throw new Error("WEB_APP_URL must be configured for guest ticket emails");
    const base = new URL(origin);
    const localHost = base.hostname === "localhost" || base.hostname.endsWith(".localhost") || base.hostname === "[::1]" ||
        /^(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(base.hostname) ||
        /^192\.168\.\d{1,3}\.\d{1,3}$/.test(base.hostname) ||
        /^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(base.hostname);
    const validOrigin = localHost
        ? options.allowDevelopmentUrls && ["http:", "https:"].includes(base.protocol)
        : base.protocol === "https:";
    if (!validOrigin || base.username || base.password || base.search || base.hash) {
        throw new Error("WEB_APP_URL must use public HTTPS, or a local website URL in development");
    }
    const link = new URL(`${base.toString().replace(/\/+$/, "")}/guest-ticket`);
    link.hash = new URLSearchParams({ token }).toString();
    return link.toString();
}
function guestTicketEmail(ticket, link) {
    return `<h1>Your guest ticket</h1>
<p>Hello ${escapeHtml(ticket.guestName)},</p>
<p>You have a ticket for <strong>${escapeHtml(ticket.event)}</strong>.</p>
<p>${escapeHtml(ticket.venue)}<br>${escapeHtml(ticket.startsAt.toUTCString())}</p>
<p>${escapeHtml(ticket.ticketType)} · Table ${ticket.tableNumber} · Seat ${ticket.seatNumber}</p>
<p><a href="${escapeHtml(link)}">Open your QR ticket</a></p>
<p>No account or app is needed. Open the link in your browser and show the QR code to staff at entry. You can arrive separately from your group.</p>
<p>This ticket admits one guest once. Keep this email private. If your seat is reassigned, ask the booking owner for a new ticket.</p>`;
}
