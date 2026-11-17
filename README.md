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
transfer endpoint. Individual and table guest tickets allow repeat entry after
checkout for the original attendee, with only one person inside per ticket. The same QR code is shown for both entry and exit.
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
select **Email guest ticket**. The API sends that guest's current QR code as a
PNG attachment, plus event details and a browser link, through Brevo. The image
is named for the guest's table and seat and is generated in memory; no public
image upload is needed. Guests can show the downloaded image at entry or open
`/guest-ticket#token=...` in a browser without signing in or
installing the app, then show the QR code to venue staff. Opening a link does not
check the guest in. Tickets show their current status; reassigned tickets no longer
open. Downloaded QR images are also rejected by the scanner after reassignment
or while already checked in. Checkout allows entry again. Email failures can be
retried without changing the ticket token.

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
Only assigned, unused, paid table tickets whose event has not ended can be
emailed. Checkout does not restore email sharing after first entry. The token protects
against sending a newly reassigned ticket from an out-of-date wallet. The email
address is used for that send; it is not stored as a guest account or profile.

For local email testing, set `WEB_APP_URL` to the website's LAN address (for
example `http://192.168.1.5:5173`), run Vite with `npm run dev -- --host 0.0.0.0`,
and point the website's `VITE_API_URL` to the backend's LAN address. Include the
website's LAN origin in backend `CORS_ORIGINS`. Recipients must use the same
network while the development servers are running. Local HTTP links are allowed
only outside production/Render; production email links still require public HTTPS.
Restart the backend after rebuilding or changing its `.env` configuration.

### Current production website

Set `WEB_APP_URL=https://ticketme-web.vercel.app` in the backend hosting
environment. Guest-ticket emails will link to
`https://ticketme-web.vercel.app/guest-ticket#token=...`.
Include `https://ticketme-web.vercel.app` in `CORS_ORIGINS`, preserving other
allowed origins. `BREVO_API_KEY` and `BREVO_FROM_EMAIL` must also be configured
for email delivery.

The web repository includes `vercel.json` with the public ticket route rewrite.
Deploy it along with the web app. Pushing to GitHub does not copy the ignored
local `.env` to Render; update Render's environment settings separately and
restart/redeploy the backend. Resend tickets after updating the website URL so
recipients receive the new link. No database migration is needed.

### Email authentication failures

`EMAIL_AUTH_FAILED` means Brevo returned HTTP 401. For example, Brevo's
`API Key is not enabled` response means the configured key cannot authenticate.
Enable or create an active **API key** in Brevo (not an SMTP password), update
`BREVO_API_KEY` in Render's backend environment, and restart/redeploy the service.
Update the ignored local `.env` separately if running the backend locally.
Use a verified sender for `BREVO_FROM_EMAIL`, then retry the same guest ticket.
No new purchase or guest reassignment is needed.

`EMAIL_NOT_CONFIGURED` means `BREVO_API_KEY` or `BREVO_FROM_EMAIL` is missing.
Other failures remain `EMAIL_DELIVERY_FAILED`; check the backend log's provider
HTTP status/code and Brevo's transactional email logs. Ticket links and API keys
are not included in the diagnostic logs or customer error responses.

## Repeat entry and visit history

Apply `npm run db:migrate` before starting this API version. Migration
`0011_ticket_visit_checkouts.sql` adds `checkedOutAt` and `checkedOutById` to
`TicketCheckIn`. Each successful check-in creates a visit; checkout closes that
visit in the same transaction as the ticket's status update. Later visits leave
previous visit records intact. Duplicate scans do not create extra visits or
replace checkout timestamps. Ticket status remains on `Ticket.checkedInAt` and
`Ticket.checkedOutAt`; a non-null entry and null exit means currently inside.

The migration backfills the latest known visit from existing tickets. Older
checkout timestamps that were never stored remain unknown. Previously attended
bookings remain ineligible for refunds, even after checkout. Guest reassignment
and account-to-account transfer remain blocked after first entry. The scanner
requires staff to verify the person against the fixed attendee name. A copied QR
or knowledge of that name alone does not establish the holder’s identity.


## QR and attendee-name verification

Apply `0012_verified_attendee_names.sql` with `npm run db:migrate`, and update
both scanner clients alongside the API. `POST /api/admin/check-in/preview`
accepts `{ "token": "..." }` and returns the attendee name, current status,
event and seat details without changing attendance. Only authorized event staff
can preview a ticket.

`POST /api/admin/check-in` now requires `attendeeName` (1–100 characters) and
`nameVerified: true` along with `token` and `action`. Staff must verify that the
person matches the displayed name before confirming. The name is fixed on the
first successful scan. Subsequent entries and exits reject a different name;
case and repeated whitespace are ignored for comparison, while the recorded
spelling remains unchanged. Preview and failed scans create no visit history.

Assigned table guest names are used directly. Individual tickets without a
recorded name require staff to capture the original attendee’s full name. This
also applies to legacy unnamed tickets on their next verified scan; the system
does not invent historic attendee identities or assume a group purchaser’s name
for every ticket. Once recorded, each ticket keeps its own attendee name. A name
match is a staff verification step, not automated identity recognition.
