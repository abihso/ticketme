# ticketme

## Whole-table bookings

Apply `npm run db:migrate` before running the updated API. Ticket types can set
`tableCapacity` to an integer from 2 to 100; null keeps individual admission.
`quantity` and `priceMinor` represent whole tables for table types. Checkout
accepts quantity 1 for a table and snapshots the capacity and assigned table
number on the purchase. Inventory reservations, failed-payment release, and
payment confirmation continue to operate on whole units.

`PATCH /api/me/tickets/:ticketId/guest` accepts `{ "guestName": "Sarah" }`
(or null to clear an unused seat). Only the paid booking's owner may assign
these tickets; each assignment rotates its QR token. Unassigned seats return
`token: null` in the wallet. `POST /api/guest-tickets/lookup` accepts a token
and returns only that guest's event, table, seat, and entry status, with no
account required. Guest tickets cannot be transferred via the individual-ticket
transfer endpoint. Table guest check-in is single-use, including after checkout.
Table numbers are unique within each ticket type among pending/paid bookings.

Run `npm run test:integration` for the table booking lifecycle and concurrency
tests. It requires local `initdb` and `pg_ctl` binaries, creates and removes a
temporary PostgreSQL cluster, applies migrations, and mocks Paystack. It does not
read the project's configured database URL or contact payment services.

## Schema synchronization

Prefer `npm run db:migrate` for databases with migration history. `db:generate`
compares schema files with snapshots; “No schema changes” does not confirm that
the database is up to date. `db:push` changes the live schema directly without
recording migrations, so mixing it with migrations can leave the journal behind.
The configuration excludes `pg_stat_*` extension objects from push/introspection;
do not drop the `pg_stat_statements` extension to resolve a schema-sync error.

## Email table guest tickets

After assigning a table guest in the Expo wallet, enter their email address and
select **Email guest ticket**. The API sends that guest's current QR link through
Brevo. Guests open `/guest-ticket#token=...` in a browser without signing in or
installing the app, then show the QR code to venue staff. Opening a link does not
check the guest in. Used tickets show their status; reassigned tickets no longer
open. Email failures can be retried without changing the ticket token.

Configure `BREVO_API_KEY`, `BREVO_FROM_EMAIL`, and optional `BREVO_FROM_NAME` on
the backend. Set `WEB_APP_URL` to the deployed website's public HTTPS origin.
New emails open the web app's `/guest-ticket#token=...` route. Set `VITE_API_URL`
in the web app to the API origin and include the website origin in the API's
`CORS_ORIGINS`. Configure the website host with a SPA rewrite for `/guest-ticket`
so direct email links resolve to `index.html`. The domain can be configured later
at deployment. `PUBLIC_API_URL` remains the API origin and is not used for new
guest email links. Previously generated backend guest links remain supported.
No database migration is required.

`POST /api/me/tickets/:ticketId/email` requires the booking owner's session and
JSON `{ "email": "guest@example.com", "token": "current-guest-ticket-token" }`.
Only assigned, unused, paid table tickets can be emailed. The token protects
against sending a newly reassigned ticket from an out-of-date wallet. The email
address is used for that send; it is not stored as a guest account or profile.

For local email testing, set `WEB_APP_URL` to the website's LAN address (for
example `http://192.168.1.5:5173`), run Vite with `npm run dev -- --host 0.0.0.0`,
and point the website's `VITE_API_URL` to the backend's LAN address. Include the
website's LAN origin in backend `CORS_ORIGINS`. Recipients must use the same
network while the development servers are running. Local HTTP links are allowed
only outside production/Render; production email links still require public HTTPS.
Restart the backend after rebuilding or changing its `.env` configuration.
