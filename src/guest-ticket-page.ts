export const guestTicketPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>Your guest ticket · Altbit</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f6f2ec;color:#191c26;font:16px/1.5 system-ui,sans-serif;padding:24px 16px}main{max-width:480px;margin:24px auto;background:white;border:1px solid #e8e2d9;border-radius:20px;padding:28px;text-align:center}h1{font-size:28px;line-height:1.2}h2{font-size:20px}p{overflow-wrap:anywhere}.brand{color:#8d3a2b;font-size:12px;letter-spacing:2px;font-weight:700}.muted{color:#656a75}#qr{display:block;width:260px;max-width:100%;height:auto;margin:16px auto}#status{padding:12px;border-radius:10px;background:#f5eee7}#error{color:#9d2c20}button{font:inherit;background:#202b3c;color:white;border:0;border-radius:10px;padding:14px 18px;cursor:pointer;width:100%}button:disabled{opacity:.5;cursor:wait}[hidden]{display:none!important}#code{font-family:monospace;user-select:all;font-size:12px}
</style></head><body><main><p class="brand">ALTBIT · GUEST PASS</p><h1>Your guest ticket</h1>
<p id="status" role="status">Loading your ticket…</p><p id="error" role="alert" hidden></p>
<section id="ticket" hidden><h2 id="event"></h2><p id="details" class="muted"></p><h2 id="guest"></h2><p id="seat"></p>
<div id="entry" hidden><img id="qr" alt="Your individual entry QR code"><p>Show this QR code to staff at entry. You can arrive separately from your group.</p><p class="muted">This ticket admits one guest once. Keep it private.</p><details><summary>Show entry code</summary><p id="code"></p></details></div></section>
<button id="refresh" type="button">Refresh ticket status</button><p class="muted">No account or app required.</p></main><script src="/guest-ticket.js" defer></script></body></html>`;

export const guestTicketScript = `(() => {
  const element = id => document.getElementById(id);
  let controller;
  async function load() {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    element('refresh').disabled = true;
    element('ticket').hidden = true;
    element('entry').hidden = true;
    element('qr').removeAttribute('src');
    element('code').textContent = '';
    element('error').hidden = true;
    element('status').textContent = 'Loading your ticket…';
    try {
      if (!token || token.length < 16 || token.length > 256) throw new Error('Open the complete ticket link in your email.');
      const response = await fetch('/api/guest-tickets/lookup', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }), signal: request.signal, cache: 'no-store',
      });
      const ticket = await response.json();
      if (!response.ok) throw new Error(ticket.error || 'Ticket unavailable. Ask the booking owner for the latest link.');
      element('event').textContent = ticket.event;
      element('details').textContent = ticket.venue + ' · ' + new Date(ticket.startsAt).toLocaleString();
      element('guest').textContent = ticket.guestName;
      element('seat').textContent = ticket.ticketType + ' · Table ' + ticket.tableNumber + ' · Seat ' + ticket.seatNumber;
      element('ticket').hidden = false;
      if (ticket.checkedInAt) {
        element('status').textContent = ticket.checkedOutAt ? 'Ticket used · checked out' : 'Ticket used · checked in';
      } else if (ticket.qrSvg) {
        element('status').textContent = 'Ready for entry';
        element('qr').src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(ticket.qrSvg);
        element('code').textContent = token;
        element('entry').hidden = false;
      } else throw new Error('Could not display your ticket. Please refresh.');
    } catch (error) {
      if (request.signal.aborted) return;
      element('ticket').hidden = true;
      element('status').textContent = 'Ticket unavailable';
      element('error').textContent = error.message || 'Could not load your ticket. Please try again.';
      element('error').hidden = false;
    } finally { if (!request.signal.aborted) element('refresh').disabled = false; }
  }
  element('refresh').addEventListener('click', load);
  addEventListener('hashchange', load);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  load();
})();`;
