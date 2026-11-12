import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

// Creates and removes its own PostgreSQL cluster. Never reads the project's database URL.
const directory = mkdtempSync(join(tmpdir(), 'ticket-table-test-'));
const secret = 'isolated-table-booking-test-secret-123456789';
let sql, server, origin, pgStarted = false;
let serverOutput = '';
const owner = randomUUID(), customer = randomUUID(), stranger = randomUUID(), otherOrganizer = randomUUID();
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error ?? result.stderr}`);
}
async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
function token(userId) {
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Date.now() + 3600_000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
async function api(path, user, method = 'GET', data) {
  const response = await fetch(`${origin}${path}`, {
    method, headers: { ...(user ? { authorization: `Bearer ${token(user)}` } : {}), 'content-type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { status: response.status, body: await response.json() };
}
async function eventType({ quantity = 1, capacity = 6, price = 60000 } = {}) {
  const result = await api('/api/admin/events', owner, 'POST', {
    title: 'Table dinner', venue: 'Test hall', startsAt: new Date(Date.now() + 86400000).toISOString(), published: true,
    ticketTypes: [{ name: 'Dinner tables', priceMinor: price, quantity, tableCapacity: capacity }],
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.ticketTypes[0].id;
}
const reserve = (id, user = customer, quantity = 1) => api('/api/purchases', user, 'POST', { ticketTypeId: id, quantity });
async function pay(reference) {
  const result = await api(`/api/payments/verify/${reference}`, customer);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
async function booking(reference) {
  const result = await api('/api/purchases', customer);
  assert.equal(result.status, 200);
  return result.body.find(item => item.reference === reference);
}
const assign = (ticket, guestName, user = customer) => api(`/api/me/tickets/${ticket.id}/guest`, user, 'PATCH', { guestName });
const scan = (token, action = 'CHECK_IN', user = owner) => api('/api/admin/check-in', user, 'POST', { token, action });
const lookup = token => api('/api/guest-tickets/lookup', null, 'POST', { token });

before(async () => {
  const pgPort = await freePort(), apiPort = await freePort();
  run('initdb', ['-D', join(directory, 'data'), '-A', 'trust', '-U', 'table_test', '--no-locale']);
  run('pg_ctl', ['-D', join(directory, 'data'), '-l', join(directory, 'postgres.log'), '-o', `-p ${pgPort} -h 127.0.0.1 -k ${directory}`, '-w', 'start']);
  pgStarted = true;
  const databaseUrl = `postgres://table_test@127.0.0.1:${pgPort}/postgres`;
  sql = postgres(databaseUrl, { max: 4, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: resolve('drizzle') });
  for (const [id, role, name] of [[owner, 'ORGANIZER', 'Owner'], [customer, 'CUSTOMER', 'Sarah'], [stranger, 'CUSTOMER', 'Other'], [otherOrganizer, 'ORGANIZER', 'Other owner']]) {
    await sql`insert into "User" (id, email, name, "passwordHash", role) values (${id}, ${id + '@example.test'}, ${name}, 'test-only', ${role})`;
  }
  origin = `http://127.0.0.1:${apiPort}`;
  server = spawn(process.execPath, ['--require', resolve('test/mock-paystack.cjs'), resolve('dist/server.js')], {
    env: { ...process.env, DATABASE_URL: databaseUrl, SESSION_SECRET: secret, PORT: String(apiPort),
      PAYSTACK_SECRET_KEY: 'isolated-test-key', BREVO_API_KEY: 'test-email-key', BREVO_FROM_EMAIL: 'sender@example.test', PUBLIC_API_URL: 'https://api.example.test', WEB_APP_URL: 'https://tickets.example.test', TEST_EMAIL_LOG: join(directory, 'emails.jsonl'), AWS_REGION: '', AWS_S3_BUCKET: '', RENDER: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { serverOutput += chunk; });
  server.stderr.on('data', chunk => { serverOutput += chunk; });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch {}
    if (server.exitCode !== null) throw new Error(serverOutput);
    await delay(50);
  }
  throw new Error(`Server did not start: ${serverOutput}`);
});
after(async () => {
  if (server && server.exitCode === null) {
    const closed = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await closed;
  }
  if (sql) await sql.end();
  if (pgStarted) run('pg_ctl', ['-D', join(directory, 'data'), '-m', 'fast', '-w', 'stop']);
  rmSync(directory, { recursive: true, force: true });
});

test('whole table: four guests, six reserved seats, private assignment and independent single-use entry', async () => {
  const type = await eventType();
  const checkout = await reserve(type);
  assert.equal(checkout.status, 201);
  assert.equal(checkout.body.amountMinor, 60000);
  assert.equal((await reserve(type, stranger)).status, 409, 'pending table cannot be sold again');
  const payment = await pay(checkout.body.reference);
  assert.equal(payment.ticketCount, 6);
  await Promise.all([pay(checkout.body.reference), pay(checkout.body.reference)]);
  const purchase = await booking(checkout.body.reference);
  assert.equal(purchase.tickets.length, 6, 'payment retries must not duplicate tickets');
  assert.equal(purchase.tableNumber, 1);
  assert.equal(purchase.tableCapacity, 6);
  assert.equal(purchase.isBookingOwner, true);
  assert.ok(purchase.tickets.every(ticket => ticket.token === null && ticket.guestName === null));
  assert.deepEqual(purchase.tickets.map(ticket => ticket.seatNumber), [1, 2, 3, 4, 5, 6]);
  assert.equal((await assign(purchase.tickets[0], 'Intruder', stranger)).status, 404);
  assert.equal((await assign(purchase.tickets[0], ' ')).status, 400);
  const issued = [];
  for (const [index, name] of ['Sarah', 'James', 'Mary', 'John'].entries()) {
    const result = await assign(purchase.tickets[index], name);
    assert.equal(result.status, 200);
    issued.push(result.body.token);
  }
  assert.equal(new Set(issued).size, 4);
  const guest = await lookup(issued[1]);
  assert.equal(guest.status, 200);
  assert.equal(guest.body.guestName, 'James');
  assert.equal(guest.body.tableNumber, 1);
  assert.equal(guest.body.email, undefined);
  assert.equal(guest.body.amountMinor, undefined);
  assert.equal((await scan(issued[0], 'CHECK_IN', otherOrganizer)).status, 404);
  const scans = await Promise.all([scan(issued[0]), scan(issued[0])]);
  assert.deepEqual(scans.map(result => result.status).sort(), [200, 409]);
  assert.equal((await scan(issued[2])).status, 200, 'another guest enters independently');
  const afterEntry = await booking(checkout.body.reference);
  assert.equal(afterEntry.tickets.filter(ticket => ticket.checkedInAt).length, 2);
  assert.equal(afterEntry.tickets.filter(ticket => !ticket.guestName).length, 2);
  assert.equal((await reserve(type, stranger)).status, 409, 'unused seats are not available to another group');
  assert.equal((await assign(purchase.tickets[0], 'Replacement')).status, 409);
  assert.equal((await scan(issued[0], 'CHECK_OUT')).status, 200);
  assert.equal((await scan(issued[0])).status, 409, 'guest ticket cannot be reused after checkout');
  const changed = await assign(purchase.tickets[1], 'Jane');
  assert.equal(changed.status, 200);
  assert.notEqual(changed.body.token, issued[1]);
  assert.equal((await lookup(issued[1])).status, 404);
  assert.equal((await scan(issued[1])).status, 404);
  assert.equal((await assign(purchase.tickets[1], null)).status, 200);
  assert.equal((await scan(changed.body.token)).status, 404);
  assert.equal((await assign(purchase.tickets[4], 'Late guest')).status, 200);
  assert.equal((await api(`/api/admin/ticket-types/${type}`, owner, 'PATCH', { tableCapacity: 8 })).status, 409);
  assert.equal((await api(`/api/admin/ticket-types/${type}`, owner, 'PATCH', { tableCapacity: null })).status, 409);
  assert.equal((await api(`/api/me/tickets/${purchase.tickets[3].id}/transfer`, customer, 'POST', { email: stranger + '@example.test' })).status, 404);
  const raceTicket = await assign(purchase.tickets[5], 'Original guest');
  const [racingScan, racingAssignment] = await Promise.all([
    scan(raceTicket.body.token), assign(purchase.tickets[5], 'Replacement guest'),
  ]);
  assert.ok(!(racingScan.status === 200 && racingAssignment.status === 200), 'scan and reassignment cannot both succeed');
  if (racingScan.status === 200) assert.equal(racingAssignment.status, 409);
  else {
    assert.equal(racingAssignment.status, 200);
    assert.equal((await scan(raceTicket.body.token)).status, 404);
    assert.equal((await scan(racingAssignment.body.token)).status, 200);
  }

});

test('concurrent bookings get exclusive tables without overselling', async () => {
  const type = await eventType({ quantity: 2 });
  assert.equal((await reserve(type, customer, 2)).status, 400);
  const reservations = await Promise.all([reserve(type), reserve(type), reserve(type)]);
  assert.deepEqual(reservations.map(result => result.status).sort(), [201, 201, 409]);
  const numbers = await Promise.all(reservations.filter(result => result.status === 201).map(async result => (await booking(result.body.reference)).tableNumber));
  assert.deepEqual(numbers.sort(), [1, 2]);
});

test('expired and failed checkouts release a whole table and reject late payment', async () => {
  const type = await eventType();
  const first = await reserve(type);
  await sql`update "Purchase" set "expiresAt" = now() - interval '1 hour' where reference = ${first.body.reference}`;
  const second = await reserve(type);
  assert.equal(second.status, 201);
  assert.equal((await booking(second.body.reference)).tableNumber, 1);
  assert.equal((await pay(first.body.reference)).status, 'FAILED');
  assert.equal((await booking(first.body.reference)).tickets.length, 0);
  await pay(second.body.reference);
  const brokenType = await eventType({ price: 999 });
  assert.equal((await reserve(brokenType)).status, 502);
  const [stock] = await sql`select sold, reserved from "TicketType" where id = ${brokenType}`;
  assert.equal(stock.reserved, 0);
  assert.equal(stock.sold, 0);
  assert.equal((await api(`/api/admin/ticket-types/${brokenType}`, owner, 'PATCH', { priceMinor: 1000 })).status, 200);
  assert.equal((await reserve(brokenType)).status, 201);
});

test('individual admission still creates the requested ticket count', async () => {
  const type = await eventType({ quantity: 10, capacity: null, price: 2500 });
  const checkout = await reserve(type, customer, 3);
  assert.equal(checkout.status, 201);
  assert.equal(checkout.body.amountMinor, 7500);
  await pay(checkout.body.reference);
  const purchase = await booking(checkout.body.reference);
  assert.equal(purchase.tableCapacity, null);
  assert.equal(purchase.tickets.length, 3);
  assert.ok(purchase.tickets.every(ticket => ticket.token && ticket.seatNumber === null));
  assert.equal((await assign(purchase.tickets[0], 'Wrong flow')).status, 404);
  assert.equal((await scan(purchase.tickets[0].token)).status, 200);
  assert.equal((await scan(purchase.tickets[0].token, 'CHECK_OUT')).status, 200);
  assert.equal((await scan(purchase.tickets[0].token)).status, 200, 'existing individual reentry remains available');
});


test('startup fails clearly when another server already owns the port', async () => {
  const duplicate = spawn(process.execPath, [resolve('dist/server.js')], {
    env: { ...process.env, SESSION_SECRET: secret, DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused', PORT: new URL(origin).port },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  duplicate.stdout.on('data', chunk => { output += chunk; });
  duplicate.stderr.on('data', chunk => { output += chunk; });
  const exitCode = await new Promise(resolve => duplicate.once('close', resolve));
  assert.equal(exitCode, 1);
  assert.match(output, /already in use/);
  assert.doesNotMatch(output, /Ticketing API listening/);
});


test('owners email browser QR links to guests without accounts, with retries and revoked-link protection', async () => {
  const type = await eventType();
  const checkout = await reserve(type);
  await pay(checkout.body.reference);
  const purchase = await booking(checkout.body.reference);
  const assigned = await assign(purchase.tickets[0], 'Guest <script>alert(1)</script>');
  const token = assigned.body.token;
  const email = (ticket, address, currentToken = token, user = customer) => api(`/api/me/tickets/${ticket.id}/email`, user, 'POST', { email: address, token: currentToken });
  assert.equal((await email(purchase.tickets[0], 'guest@example.test', token, stranger)).status, 409);
  assert.equal((await email(purchase.tickets[0], 'bad-address')).status, 400);
  assert.equal((await email(purchase.tickets[1], 'guest@example.test')).status, 409);
  assert.equal((await email(purchase.tickets[0], 'fail@example.test')).status, 502);
  assert.equal((await booking(checkout.body.reference)).tickets[0].token, token, 'provider failure does not rotate or consume a ticket');
  const sent = await email(purchase.tickets[0], 'Guest@Example.test');
  assert.equal(sent.status, 200);
  const messages = readFileSync(join(directory, 'emails.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const message = messages.at(-1);
  assert.equal(message.to[0].email, 'guest@example.test');
  assert.match(message.htmlContent, /Guest &lt;script&gt;/);
  assert.ok(!message.htmlContent.includes('<script>alert'));
  const link = new URL(message.htmlContent.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&'));
  assert.equal(link.origin, 'https://tickets.example.test');
  assert.equal(link.pathname, '/guest-ticket');
  assert.equal(link.search, '');
  assert.equal(new URLSearchParams(link.hash.slice(1)).get('token'), token);
  const page = await fetch(origin + '/guest-ticket');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await page.text(), /No account or app required/);
  const opened = await lookup(token);
  assert.equal(opened.status, 200);
  assert.match(opened.body.qrSvg, /^<svg/);
  assert.equal(opened.body.checkedInAt, null, 'opening email link must not check in the guest');
  assert.equal((await email(purchase.tickets[0], 'guest@example.test')).status, 200, 'resending keeps the same ticket valid');
  await assign(purchase.tickets[0], 'New guest');
  assert.equal((await lookup(token)).status, 404);
  assert.equal((await email(purchase.tickets[0], 'guest@example.test')).status, 409, 'stale wallet cannot email a new guest token');
  const latest = (await booking(checkout.body.reference)).tickets[0].token;
  assert.equal((await scan(latest)).status, 200);
  assert.equal((await lookup(latest)).body.qrSvg, null);
  assert.equal((await email(purchase.tickets[0], 'guest@example.test', latest)).status, 409);
});
