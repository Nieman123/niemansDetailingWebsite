# Payments, appointments, and CMS integration plan

Prepared and expanded November 16, 2026. Planning only; no application changes or deployments. First-release scope includes phone/text appointment links, trusted-client deposit waivers, mobile onsite closeout, maintenance enrollment invitations, optional account credentials, three-calendar availability, and an installable admin PWA.

## 1. Outcome and confirmed decisions

Build a complete customer booking/payment experience and an integrated business/content admin inside the existing Nieman's Detailing website.

**Launch supports three booking paths: online deposit-first requests, owner-created appointment/deposit links after a call or text, and owner-confirmed appointments with no deposit for trusted clients.** The public new-client flow remains: choose an available appointment → pay $50 → pending owner approval → confirmed. Owner-arranged appointments can be preapproved, so deposit payment confirms them without a redundant review step. These paths share one appointment, calendar, and payment system.

| Area | Decision |
| --- | --- |
| Booking | New/unverified clients, especially ad/quote leads, default to the online $50 deposit flow. Phone/text bookings can use an owner-created appointment link; trusted clients can have no-deposit appointments. |
| Approval | Public requests require approval after payment. Owner-created bookings record approval at creation: required deposit payment confirms a preapproved appointment, or a waived-deposit appointment is confirmed immediately. |
| Deposit | $50 USD, credited toward the service total. Capture the payment immediately; do not use a long-lived card authorization hold. |
| Trusted clients | Owner-controlled client default plus per-appointment override: deposit required or waived. Waived means $0 collected and $0 credit, not a fictitious $50 payment. |
| Appointment links | First-release requirement: create/copy/share/email a branded appointment link with details, Add to calendar, and deposit or remaining-balance payment as applicable. No password required. |
| Pending requests | Keep pending and alert after 24 hours. If still unapproved when the requested start time arrives, cancel, release the slot, and initiate a full refund. |
| Cancellation before approval | Full $50 refund, including requests less than four days away. |
| Confirmed cancellation | Full deposit refund at least 96 hours before the appointment; no deposit refund inside 96 hours. Exactly 96 hours is refundable. |
| Rescheduling | Customers request a new time; Nieman approves the move. Carry the same deposit forward. |
| Refund eligibility after moving | Once a confirmed appointment has entered its nonrefundable window, moving it does not restore refund eligibility. |
| No-show | Deposit is forfeited for a confirmed appointment. A never-approved request is not a no-show. |
| Owner/weather cancellation | Customer may receive a full refund or agree to another appointment using the same deposit, including when the deposit was previously nonrefundable. |
| Final balance | Mobile onsite flow records notes/photos and final line items/upcharges, then generates a payment link or records cash, check, Venmo, Cash App, or another external method. No automatic saved-card charging in this scope. |
| Maintenance conversion | First release includes an optional owner-selected email invitation after a full detail is completed and fully paid, offering monthly maintenance enrollment within 60 days of the full detail. |
| Customer access | Passwordless appointment links/email sign-in remain the default; optional email/password and Google sign-in link to the same account for future bookings. |
| Calendar | Reuse the existing Detailing Google calendar. Block availability against Detailing, personal, and Pluto Events calendars. |
| Mobile app | Installable Android-focused admin PWA with Today/current-job workflow and payment closeout. |
| Admin scope | Operations and structured site content: customers, appointments, payments, services/prices, availability, blog, photos, and key page content. |
| Scheduling configuration | Working hours, service durations, travel buffers, and booking horizon will be configured before launch. Do not invent public availability. |

For public deposit-first requests, the 24-hour period is an owner-review alert threshold, not an automatic refund deadline. Owner-created deposit links need a separate, visible slot/payment deadline; recommend 24 hours, shortened by the owner for near-term work and always before the appointment starts. This new recommendation does not change the pending-review timeout for public requests. Trusted-client confirmed appointments have no payment-hold expiry.

## 2. What exists today

This is a repository inspection, not an audit of deployed Firebase data, Google calendars, Stripe settings, or live production behavior.

| Component | Current implementation | Integration implication |
| --- | --- | --- |
| Public website | Static HTML, CSS, vanilla JavaScript in `public/`; Firebase Hosting. | Retain marketing pages, URLs, SEO, and fast loading. Add application pages progressively. |
| API | `functions/index.ts`, TypeScript, Firebase Functions v2 in `us-east1`; Node 20 declared. | Extend the backend with modules for appointments, billing, authorization, and integrations; review supported runtime at implementation time. |
| Quote flows | `/quote`, `/ceramic-quote`, shared `public/quote.js`; server-calculated estimates. | Preserve quick quote/contact capture. Offer booking from the quote receipt with selections carried forward. |
| Lead API | `/api/createLead`, `/api/quoteProgress`, `/api/leadOptions`. | Preserve old clients and existing lead tracking during rollout. |
| Add-on edits | Hashed, scoped 24-hour lead-edit tokens; no public lead reads. | These tokens are not customer portal credentials. Lock/revise submitted scope through the appointment system after payment. |
| Current scheduling | `public/schedule.html` embeds a Google appointment schedule. | Replace the embed with first-party availability and checkout. Retire the old booking link at cutover so it cannot bypass deposit rules. |
| Lead dashboard | `public/admin/index.html`, `public/scripts/admin-dashboard.js`; statuses, filtering, funnel metrics, vacation mode. | Add paid requests, review queues, calendar, and financial status without confusing leads with confirmed appointments. |
| Client manager | `public/admin/clients.html`, `public/scripts/admin-clients.js`; contact data, notes, follow-up dates, tags, imports/exports, manual booking history. | Keep records and IDs. Move future appointments into dedicated documents. |
| Booking history | Embedded `clients.bookings[]` contains date/service/amount/notes; merging currently caps at 120 records. | Historical amounts are not proof of payment. Preserve history; do not fabricate Stripe transactions during migration. |
| Admin access | Firebase Google sign-in plus `adminUsers/{uid}` allowlist. | Reuse authentication, introduce roles, and verify permissions on the server for financial operations. |
| Content CMS | Firestore `blogPosts`, image uploads, static build via `scripts/build-blog.mjs`. | Expand structured editing and add an explicit draft/preview/publish/build-status workflow. |
| Pricing | Duplicated in `functions/index.ts` and `public/quote.js`, with copy in static service pages. | Establish one versioned catalog; generate public displays and calculate billable amounts on the server. |
| Notifications | Telegram owner alerts; customer follow-up is currently manual. | Keep Telegram; add transactional email and reliable delivery tracking. |
| Security rules | Public lead access denied; allowlisted admins can directly modify clients/leads. | Protect payment and appointment invariants with server-only mutations and field-level restrictions on legacy writes. |
| Deployment | GitHub deploys Hosting, rules/indexes, and explicitly `functions:api`. | Add every new webhook/worker/trigger to deployment. Existing `notifyLeadAddonUpdate` is also omitted from this workflow's function list. |
| PWA | `public/manifest.json` already declares standalone display and home start URL, with icons through 192px; the current service worker clears caches and unregisters itself. | Add a dedicated admin launch experience, complete icon/manifest assets, and replace the retirement worker deliberately. Keep financial operations online and private responses uncached. |
| Maintenance service | `public/services/monthly-mini.html` describes Monthly Mini; displayed pricing is $100 sedan / $140 SUV, truck, or van, limited to vehicles with a full detail in the last 60 days and 60–75 minutes. | Reuse the service page as the enrollment destination, but confirm catalog pricing/duration and eligibility before enabling paid maintenance bookings. |

Observed current server prices, to migrate without silently changing them:

| Service | Sedan | SUV/truck | Van/3-row SUV |
| --- | --- | --- | --- |
| Quick Once Over | $200 | $250 | $300 |
| Full Detail | $300 | $350 | $400 |
| Interior Only | $200 | $250 | $300 |

Ceramic flow currently starts at $1,000 single-step or $1,400 two-step correction/coating, adds $400 for its SUV category, and requires a custom price for truck/van/other or “Help me choose.” Its category labels differ from the detailing flow. The old `paint` service alias currently maps to `interior_only`; migration must preserve old lead interpretation without presenting that alias as a new paint-correction product.

## 3. Recommended architecture

Keep Firebase Hosting, Firestore, Firebase Auth, Cloud Storage, and TypeScript Functions. Add Stripe Checkout Sessions with an embedded payment experience, Google Calendar API, a transactional email provider, and background delivery/reconciliation jobs.

Use modular frontend code and shared components for the booking, account, and admin areas. A site-wide framework rewrite is unnecessary. Extract existing oversized admin scripts into domain modules as they are touched; do not make a public-site rewrite a prerequisite for payments.

| System | Owns |
| --- | --- |
| Firestore | Booking lifecycle, reservations, policy snapshots, customer access, service catalog, approval history, balances and payment allocations. |
| Stripe | Payment execution, card details, refunds, disputes, transaction receipts. Store Stripe identifiers locally, not card numbers. |
| Google Calendar | A synchronized operational view of appointments and external busy periods. It does not decide deposit or refund policy. |
| Cloud Storage | Public marketing media and separately protected customer/job media. |
| Background workers | Email/Telegram delivery, calendar writes, refund retries, review reminders, expiration, reconciliation. |

Use an outbox: commit the business decision and a durable side-effect job together, then deliver calendar/email/payment side effects with retries. Never put Stripe or Google network calls inside a Firestore transaction callback, which may run more than once.

## 4. Customer experience

### Online quote-to-booking and deposit flow

Preserve both ways of working after `/quote` and `/ceramic-quote`: clients can continue by text/call and receive a tailored appointment link, or use a clear “Choose a time & pay deposit” action on the receipt leading into the enhanced `/schedule` flow. Reuse vehicle, package, add-ons, lead ID, and campaign attribution; do not force another quote submission or count the handoff as a new lead. A returning verified client may receive an owner-set deposit exemption; unknown/unverified visitors cannot claim trusted status themselves.

1. Enter from a service page, quote receipt, or `/schedule`. Carry forward known vehicle/service choices and lead attribution; avoid asking twice.
2. Choose service and vehicle; show an estimate or clearly explain that the final quote needs review. Collect add-ons affecting duration before showing availability.
3. Enter service address/ZIP and choose an exact available date/time. Explain mobile-service requirements such as access, water/electricity, and weather arrangements using configured service requirements.
4. Collect name, email, phone, vehicle details, and optional notes/photos. Email is required for public online booking/account access; phone-only quote requests and owner-created text-link appointments remain supported separately.
5. Show a persistent summary: requested date/time, service address, service scope, estimated total or “price to be confirmed,” **$50 due now**, deposit credit, and approval/cancellation policy. Identify estimates as estimates.
6. Accept the policy and pay through embedded Stripe Checkout. Primary action: “Pay $50 & request appointment.” State before payment that the appointment still requires Nieman's approval.
7. Show “Deposit received — awaiting approval,” the held time, amount paid, email destination, and next steps. If payment reconciliation is still running, show a processing state instead of an unsupported success claim.
8. Email a receipt/status link. Clients access their account using a verified email sign-in link; initial guest checkout is not permission to read an entire customer record.

For an authenticated client with an owner-set waiver, replace deposit language/actions with “No deposit required” and “Request appointment.” Submit for owner review without a Stripe Session or artificial payment/credit. The initial eight-step description above is the required-deposit branch; do not display a $50 charge to a waived client.

Only available, correctly configured service slots can be sold. “Deposit before approval” does not allow two paid requests to reserve the same capacity or let an unsupported job bypass service-area/duration checks. For custom-priced work, configure a realistic reservation duration before making that service bookable; show the scope/price as subject to review.

### Owner-created appointment links after calls/texts — required for first release

From a lead, an existing client, or a “New appointment” button:

1. Select/create the client, reuse vehicle/address data, choose service, date/time, duration, and agreed estimate. Run the same three-calendar/resource conflict checks as public booking.
2. Select **Require $50 deposit** or **No deposit required**. Preselect the client's owner-maintained preference; show a clear one-appointment override. New ad/quote leads default to a required deposit; existing clients are not automatically trusted simply because a record matches their name/phone.
3. Save owner approval with the appointment. A deposit-required booking becomes **Awaiting deposit** with a visible reservation deadline; a no-deposit booking becomes **Confirmed** immediately.
4. Generate a branded appointment page and provide **Copy link**, mobile share, and **Send appointment email**. Email includes service, vehicle, address, date/time, preparation information, payment requirement/status, and Add to calendar. If only a phone number is available, copy/share the link for a personal text; do not require email or an account just to pay for that appointment.
5. The appointment page opens directly to the details and **Pay $50 deposit** when needed. Successful payment on a valid preapproved booking confirms it immediately. No-deposit pages say “No deposit required” and show the full amount due after service.
6. After the job, the same stable appointment page exposes the current balance-payment action and receipt. Do not send a generic Stripe link disconnected from the appointment record.

The customer-facing link is distinct from an expiring Stripe Checkout Session. Sessions are created/resumed server-side when the client pays. The link remains useful for status/details after a session expires, but never reopens an expired reservation or collects an obsolete amount. Owner actions can revoke/rotate a link or resend a fresh one without creating another appointment.

Recommended owner-created hold expiry: reconcile all active payment attempts, release unpaid capacity after the stated deadline, and show “This time needs reconfirmation” with a contact/rebooking action. Expired links must not accept a deposit until the owner renews the reservation and availability is rechecked. For near-term holds shorter than Stripe's normal session expiry, explicitly expire/reconcile checkout at the hold deadline; do not rely on the browser clock.

An owner-required deposit booking is already approved conditionally on payment: the confirmation/cancellation cutoff must be disclosed before payment. Paying inside 96 hours confirms a nonrefundable deposit, unlike cancelling an unapproved public request. Owner decline/weather exceptions still refund. Deposit-waived bookings never imply a $50 cancellation charge or a $50 balance credit.

### Direct link access and Add to calendar

Use a high-entropy, revocable, appointment-scoped link, with only its hash stored server-side. Exchange its token for a limited session and remove it from the address bar before loading analytics/third-party UI. Prefer a URL fragment for delivery; do not include contact details in URLs. Apply noindex, no-store, safe referrer policy, rate limits, and no third-party tracking to the link landing page. Possession permits this appointment's customer-facing details and payment only; it does not expose full account history, internal notes/photos, trust status, or other clients. Changing sensitive details or cancelling/rescheduling requires verified access or owner assistance. Email-account sign-in remains available without a password.

Show **Add to Google Calendar** and a downloadable **.ics** option for Apple/Outlook/other calendars, containing the start/end, timezone, service, and location. Clearly label unpaid/pending requests as tentative; confirmed appointments use confirmed wording. Do not embed secret appointment tokens or private notes in exported event descriptions. An Add to calendar action does not authorize access to a customer's calendar and does not change booking/payment state.

Send updated appointment emails after reschedules/cancellations, and use stable calendar UID/sequence values in calendar attachments. A manually imported .ics or Google add-event link is not guaranteed to update automatically; the appointment page remains authoritative and emails explain changes. If email invitations are used, coordinate them with calendar sync so clients do not receive duplicate events or duplicate notifications.

### Approval and alternate times

- Approval turns a paid request into a confirmed appointment and sends confirmation/preparation instructions.
- If price, service scope, address, or start time changes materially during review, send a revised offer for client acceptance. A $50 payment does not authorize an undisclosed service price or a different appointment.
- If Nieman cannot accept the original request, offer an alternative or decline/refund. Declining must not strand the deposit.
- The client explicitly accepts an alternate time before confirmation. While waiting, the deposit remains refundable if the appointment has never been confirmed.
- Recommended alternate-offer behavior: hold one replacement slot for 24 hours or until its start time, whichever is earlier; explain when the original slot is released. Expired/rejected offers trigger refund and release. Treat this as a configurable product default, not a previously confirmed user decision.
- After 24 hours without owner action, alert/escalate while preserving the original reservation. At the requested start time, a still-unapproved request is cancelled and a full refund is initiated. Explain this before payment and in the pending screen.

### Manage an appointment

Create `/account` and `/account/appointments/:id` with:

- Clear status: awaiting review, confirmed, change requested, in progress, completed, cancelled.
- Date/time in America/New_York, address, vehicle, service, preparation checklist.
- Quote/approved total, collected deposit or explicit waiver, additional payments, refunds, and remaining balance.
- For collected deposits, exact refundable-until date/time or “Deposit is nonrefundable; you can still request a reschedule.” Waived appointments show no deposit refund/forfeiture claim.
- Request reschedule, cancel, pay balance, view receipt, and contact Nieman.
- Pending requests can be cancelled for a full refund. Once approved, apply the confirmed cancellation rules.
- Reschedule requests show that the existing confirmed time remains active until approval. Let the customer withdraw a change request.
- Sensitive actions have a confirmation screen showing the dollar consequence before submission. Cancellation must remain available even if no refund is due.

No password setup is necessary. Sign-in emails must support a different browser/device, safe return destinations, expired-link recovery, and a new-link request. Offer **Continue with Google** and optional **Create a password** in account settings, alongside email-link access, for clients who prefer an account for repeat scheduling. Implement password reset and authenticated provider linking to the existing Firebase UID, with credential-collision recovery; never create duplicate client/payment histories or merge records based only on an unverified email match. A customer Google login does not grant admin privileges or Calendar API permissions. Internal notes, customer-matching data, and administrative audit records never appear in customer API responses.

### Payment after service

Nieman confirms final line items, discounts, and any configured tax treatment, then sends “Pay remaining balance.” Example: approved $300 job less $50 deposit leaves $250. Scope increases require customer acceptance before work/collection; do not silently add charges.

Online payments use a new Checkout Session for the currently outstanding amount. In-person/external payments record method, amount, time, and operator; do not mislabel them as Stripe payments. Correct mistakes through reversal entries. Optional tips and terminal/card-reader support are later enhancements unless separately requested. The mobile closeout workflow, supported methods, and maintenance invitation are first-release requirements detailed in section 9.

## 5. Deposit and cancellation engine

All calculations use server time, integer cents, USD, UTC timestamps, and America/New_York display/business rules. Define four days as 96 elapsed hours, including across daylight-saving changes.

| Situation | Deposit outcome | Appointment action |
| --- | --- | --- |
| Payment fails or checkout expires | No successful deposit to refund. | Release checkout reservation after payment reconciliation. |
| Client cancels before owner approval | Refund full $50. | Cancel/release request. |
| Owner declines | Refund full $50 unless the client accepts a replacement. | Release declined slot; track replacement separately. |
| Still unapproved at start | Refund full $50. | Auto-cancel/release; notify client and owner. |
| Confirmed cancellation at least 96 hours ahead, with no prior nonrefundable lock | Refund full $50. | Cancel/release. |
| Confirmed cancellation inside 96 hours | Retain $50. | Cancel/release. |
| Approved reschedule | Carry the same $50 toward the same service obligation. | Move reservation atomically and update calendar. |
| No-show on confirmed appointment | Retain $50. | Owner marks no-show with reason/history. |
| Owner/weather prevents service | Full refund or client-agreed replacement, even if previously locked. | Record owner/weather exception. |
| Owner grants exception | Explicit full/partial refund or deposit waiver. | Record actor, reason, amount, and prior state. |
| Trusted-client deposit waiver | $0 deposit collected; no deposit refund/forfeiture or credit. | Owner may confirm immediately; full service balance remains payable. |
| Preapproved owner link paid | Apply the disclosed confirmed-booking policy, including the current cutoff. | Confirm once payment is verified; do not enter pending owner review again. |

Store a policy version and exact accepted text with each payment/request. Later policy edits do not retroactively change existing appointments.

For confirmed appointments, persist a monotonic `deposit_nonrefundable_locked_at` when a cutoff is crossed. Do not rely only on a scheduled job: every cancellation/reschedule/approval evaluates current time against the existing cutoff inside the same transaction. Evaluate the old appointment's cutoff before moving it. A request submitted early but approved after the old cutoff does not reset eligibility; show this behavior explicitly. Owner approval into an already-inside-96-hours slot makes the deposit nonrefundable from that approval onward. Pending requests remain refundable regardless of the requested date.

A new earlier date may create an earlier cutoff; a move made before any cutoff may use the new date. Once locked, later moves cannot unlock it except through an audited owner/weather exception. Keep deposit allocation separate from cash: rescheduling transfers credit, not another charge/refund.

For launch, recommend no automatic expiration or numerical limit on deposit-preserving reschedules, since each move requires approval. Record the count and allow owner intervention. If a later credit-expiration policy is desired, decide and disclose it before collecting affected deposits.

The deposit policy governs collected deposits only. Refunds of additional payments require a separate line-item decision; do not accidentally retain an entire prepaid balance under a $50 forfeiture rule. Deposit-waived clients owe the full service total after completion. Waiving a requirement after money has already been collected must explicitly refund or preserve that payment as credit; changing a flag must never erase money history. Client-default changes affect future bookings, not the accepted policy of existing appointments.

## 6. Reservation correctness and state model

Separate appointment, payment, refund, and calendar-sync statuses. A single `status: paid` cannot describe all four.

| Domain | Example states |
| --- | --- |
| Appointment | `draft`, `awaiting_deposit` (owner-preapproved), `checkout_pending`, `pending_approval`, `awaiting_customer_acceptance`, `confirmed`, `in_progress`, `completed`, `declined`, `cancelled`, `no_show`, `expired` |
| Deposit requirement | `required`, `waived`, with owner decision, reason, amount, and a snapshot of the applicable client default. |
| Change request | `requested`, `approved`, `rejected`, `withdrawn`, `expired` |
| Payment | `created`, `processing`, `succeeded`, `failed`, `partially_refunded`, `refunded`, `disputed` |
| Refund | `requested`, `submitted`, `pending`, `succeeded`, `failed` |
| Calendar sync | `pending`, `synced`, `retrying`, `action_required` |

Recommended checkout reservation: 30 minutes, matching the documented minimum configurable Stripe Checkout expiry. It starts only on the server when checkout is initiated. Never extend reservations indefinitely through refreshes or create multiple active payment sessions for the same deposit obligation.

Use deterministic resource/day lock documents and transactionally test all overlapping blocks for the assigned resource, including travel/setup buffers and cross-midnight work. A query followed by an unrelated write is not sufficient protection against concurrent reservations. Start with one resource, Nieman; retain resource IDs so a second detailer can be added later.

Successful payment converts the checkout reservation into a paid pending reservation. Paid pending requests block availability until approved, declined/cancelled, or expired at start time. Unpaid holds use explicit expiry checks; Firestore TTL deletion is housekeeping, not the correctness mechanism.

That transition applies to public unapproved requests. For a preapproved owner-created link, successful payment converts the unpaid reservation directly to confirmed. A waived-deposit owner appointment reserves capacity and confirms without a payment event. An authenticated trusted client booking online can submit a $0-deposit request, still requiring owner review unless the owner preapproved it; at start-time expiry there is no refund transaction to fabricate. All reservation types block the same capacity, use the same conflict checks, and are visible in the calendar. Track `booking_channel` separately from original acquisition source so an ad lead finalized by text retains its attribution.

Before releasing an expired hold, reconcile its Stripe Session/PaymentIntent. A delayed webhook for an already successful payment must not silently lose its reserved slot. Use a `reconciling` state when Stripe is unreachable; pause selling that capacity until resolved. If payment succeeds after capacity genuinely became unavailable, initiate a full refund and offer rebooking; do not double-book.

Rescheduling transactionally reserves the replacement and releases the old time, records history, and preserves the deposit allocation. Until approval, the original confirmed slot remains held. A requested replacement is not guaranteed; recheck when approving. No extra deposit is collected.

Approval, cancellation, cutoff locking, and start-time expiry must serialize against the same appointment version. If cancellation wins, a later approval cannot resurrect the booking. Financial side effects use unique operation IDs and are retried outside the transaction.

## 7. Stripe integration

### Initial approach

Use Checkout Sessions with an embedded Stripe UI inside the site's dark/navy/purple design. Test supported express wallets and browser behavior; keep a hosted Checkout fallback for unsupported embedded environments. Load Stripe only on payment screens. Stripe Connect is unnecessary for this single business. Monthly maintenance enrollment is in scope; the proposed first release bills each completed maintenance visit through the same online/external-payment flow. Automatic monthly subscription charging requires a separate explicit choice about prices, billing dates, missed visits, and authorization; do not silently enroll or charge a subscription from an invitation.

- Server creates payment sessions for a known appointment obligation, using the authoritative amount/currency and authenticated/scoped access.
- Initial deposit methods should be cards and supported card wallets, avoiding delayed settlement methods for time-sensitive reservations.
- Add metadata for appointment ID, customer/client ID, obligation type, policy version, and quote version; omit sensitive notes/addresses.
- Use Stripe idempotency keys plus local unique obligation/operation IDs. Resume the current active session rather than creating a second deposit charge.
- Create/link a Stripe Customer server-side. Never trust a browser-supplied Stripe Customer ID as proof of ownership.
- Capture $50 at checkout. Do not treat a card authorization as a deposit held indefinitely awaiting approval.
- Do not save cards for off-session charging without a separate, explicit consent feature.

### Webhooks and reconciliation

Create a dedicated HTTPS endpoint and verify Stripe signatures against the original raw request body. Persist accepted events durably before acknowledgement; process with retries and an event/obligation ledger. Return failure when durable receipt cannot be saved so Stripe retries.

Handle successful/expired checkout, failed payment, refunds, disputes, and any enabled asynchronous payment outcomes. Pin and document the Stripe API version. Verify successful payment status, expected amount/currency, environment, and appointment mapping before moving to `pending_approval` for public requests or `confirmed` for valid owner-preapproved requests. Final-balance success updates the ledger/settlement state and may trigger an owner-selected maintenance invitation; it must not reset appointment approval.

Redirects and browser success messages are not proof of payment. A return page may call a shared server reconciliation path for faster feedback, but both it and webhooks must converge idempotently. Duplicate or out-of-order events cannot create duplicate bookings, charges, credits, refunds, or confirmation emails.

Reflect refunds/disputes initiated from Stripe Dashboard in the CMS. Refund initiation, pending bank processing, and successful refund are distinct states. Refund failures create an owner action item. Freeze disputed funds from contradictory automated refund/allocation operations until reconciled.

For final-balance collection, version the approved total. If the total changes or an in-person payment is recorded, invalidate/reconcile any active online checkout first. If a concurrent payment still causes an overpayment, flag and refund the excess through a tracked operation; never quietly overcollect.

Run scheduled reconciliation for unresolved payments/refunds, expired checkout holds, and missed webhook processing. Stripe is the payment execution record; the application maintains an explainable allocation ledger.

## 8. Google Calendar integration

Connect the owner's Google account through a separate server-side OAuth consent flow. Existing Firebase Google sign-in is not Calendar authorization, and ChatGPT's Calendar connection does not authorize the website backend.

Reuse Nieman's existing **Detailing** Google calendar as the appointment write destination; do not create a duplicate calendar by default. Check busy time across **Detailing**, **personal**, and **Pluto Events**. Resolve/select exact calendar IDs during setup; do not rely on display names alone. The connected account needs access to all selected calendars; support shared-calendar selection or an additional owner connection if needed. Personal/Pluto calendars are read-only availability inputs, not write destinations for customer appointments. Their event titles/details are not exposed to customers; availability uses occupied intervals.

Availability combines working hours, exceptions/vacation, service/vehicle duration, add-on duration, travel/setup buffers, internal reservations, and Google busy intervals. Address changes that affect service area or travel require review. Start with configurable conservative buffers; route optimization is a later feature.

Create clearly labeled pending events for paid requests, awaiting-deposit events for owner-created reservations, and confirmed events after approval/payment or an owner deposit waiver. Include service, vehicle, address, payment summary, and a protected admin link as appropriate to the calendar's visibility. Keep customer-sensitive details off broadly shared calendars and never embed secret portal tokens. Store appointment ID in private extended properties and use deterministic event identity/retries to prevent duplicates. Use the customer's Add to calendar feature independently of the owner's availability connection.

Do not let the app's own mirrored Google events block their corresponding internal appointments twice. For the Detailing calendar, reconcile event IDs to internal reservations and handle externally created events as additional busy blocks. For personal and Pluto Events calendars, use free/busy without unnecessary content ingestion.

Recommended launch rule: booking changes happen in the CMS. Calendar edits/deletions trigger a discrepancy alert, not an automatic refund, cancellation, or silent new customer commitment. An admin can reconcile the change. This avoids bidirectional sync turning a dragged event into an unintended business decision.

Use push notifications as invalidation signals and incremental sync to fetch changes. Renew expiring watch channels, handle invalid sync tokens with full resync, and run periodic catch-up. Validate incoming channel/resource identifiers and channel tokens. Suppress loops caused by our own writes.

Recheck external availability shortly before taking a checkout hold and before approving/moving a booking. There is no atomic transaction spanning Google Calendar and Firestore: if a new external event races a reservation, show a conflict to Nieman and offer a client-approved alternative or refund. Do not promise impossible cross-system double-booking guarantees.

When any required calendar's busy data is stale/unavailable beyond a configured short freshness threshold, keep quote intake and owner drafts working but pause new slot reservations/confirmations until availability can be checked, including deposit-waived and owner-created bookings. Do not interpret a permission error on Pluto Events or personal as an empty calendar. When a calendar write fails after a reservation/payment, retain the internal reservation, retry, and show sync health. Never lose an appointment because its calendar mirror failed.

Store OAuth client secrets/refresh tokens server-side, handle revocation/reconnect, and configure production OAuth consent appropriately. Test-mode token lifetimes must not be mistaken for a permanent production connection.

## 9. Admin CMS and customer management

Build a shared mobile-friendly admin shell around the existing tools.

| Area | Launch capabilities |
| --- | --- |
| Overview | Mobile Today/current-job screen, paid requests awaiting approval, overdue review, awaiting-deposit links, change requests, unpaid balances, failed refunds/sync/email. |
| Appointments | Calendar/list views; create preapproved links or no-deposit bookings; approve, propose alternate, decline/refund, reschedule, cancel, no-show, complete. Filter by appointment/payment status separately. |
| Customers | Existing manager plus trusted/deposit defaults, vehicles, addresses, appointments, balances, receipts, maintenance enrollment, follow-ups, and private notes. Manual duplicate review/merge. |
| Payments | Deposit allocations, final line items/upcharges, online links, cash/check/Venmo/Cash App records, split payments, refunds, disputes, export, Stripe links. Separate received funds, refunds, balances, and earned service revenue. |
| Services/pricing | Service/vehicle prices, add-ons, duration/buffer adjustments, bookability, service requirements, custom-price flags, display order, versioned publication. |
| Availability | Working hours, blocked dates, vacations, exceptions, travel buffers, booking horizon/lead time, resource selection, Google calendar connections. |
| Content | Blog, service-page copy, FAQs, homepage editable sections, service areas, before/after galleries, approved testimonials, contact/preparation information. |
| Settings | Policy versions, sender/contact identity, notification timing, integration health, admin roles, permitted manual overrides. |

Admin money/status changes call authenticated backend commands. The browser cannot arbitrarily set `paid`, alter cutoff history, or modify a Stripe ID. Each command records actor, reason, before/after values, timestamp, and operation ID. Restrict editors to content; only financial/owner roles can refund or record payments.

Phone/text bookings are a primary launch workflow, using section 4's preapproved appointment links and optional deposit requirement. Provide copy/share/email actions from the lead, client, calendar, and job screens. Trusted-client defaults are owner-maintained and auditable; any waived deposit or legacy paid booking is explicitly marked, not forged as a Stripe transaction.

Replace load-everything client/lead lists with indexed, paginated views and useful server-calculated dashboard summaries. Preserve existing Google Ads export/follow-up workflows with appropriate consent controls.

### Mobile onsite job workspace — required for first release

Design for one-handed Android use while working at a vehicle: Today → current appointment → job notes → final total → collect/record payment → optional maintenance invitation. Keep a sticky primary action, large touch controls, readable outdoor contrast, and minimal typing. Desktop remains available for larger admin tasks.

1. **Open/start job:** show client/vehicle, address with directions, service scope, agreed estimate, deposit or waiver, and call/text actions. Mark arrival/start without implying payment.
2. **Record condition and work:** private notes, checklist, before/after photos, start/finish times, and additional work such as heavy soil or pet hair. Autosave to the server with visible saving/saved/error state. Preserve an unsaved in-memory draft across transient network errors; warn before leaving/reloading with unsaved work. Persistent offline customer-data storage is not part of the initial PWA scope.
3. **Adjust the final total:** add/remove line items, custom upcharges with reasons, discounts, and configured taxes. Keep original estimate and revisions. Record when/how the client agreed to additional work, including an owner-recorded verbal/text approval; allow final entry after the job without hiding the revised total from the customer.
4. **Review closeout:** itemized total, successful payments/deposit credit, refunds/reversals, and amount due. For a waived-deposit $300 job, due is $300; with a collected $50 deposit, due is $250. Completing the work and settling the bill are separate states.
5. **Choose payment path:** **Send/copy payment link** (also show a scannable QR for the current balance), or **Record payment** with cash, check, Venmo, Cash App, or other specified method. Permit split/partial payments, show the remainder, and prevent repeated taps from recording duplicates.
6. **Finish:** show completed/paid or completed/balance due, receipt/send actions, any uncleared check, and optional “Invite to monthly maintenance after payment.” The invitation choice persists while waiting for payment and is also available after settlement.

Use one reusable appointment URL; checkout sessions always resolve the latest finalized balance. A previously sent link must show “Paid” after an external settlement instead of accepting another full payment. Handle simultaneous Stripe/external payments through reconciliation and an explicit overpayment correction, not hidden overwrites.

### Payment records and bookkeeping exports — required for first release

Each entry records amount/currency, method (`stripe`, `cash`, `check`, `venmo`, `cash_app`, `other`), received/paid timestamp, recorded timestamp, operator, client/appointment ID, deposit/final/other allocation, and optional provider/reference or check number. Keep customer service totals, gross receipts, refunds, fees, and net proceeds as separate fields. Never store bank-account details or customer payment credentials in notes.

For checks, distinguish received/pending clearance, cleared, and returned. Show “Check received — awaiting clearance”; only count cleared checks toward settled-in-full status and maintenance-send eligibility by default. A returned check reverses settlement and restores the receivable. For Venmo/Cash App, record owner-verified receipt and an optional transaction reference; selecting that method does not initiate a transfer or integrate those providers automatically.

Provide date-range CSV exports of transaction entries and appointment/invoice summaries, filterable by payment method/client/service, including reversals/refunds and known processing fees. Report missing fee data as unknown, not zero. Store service-completion date separately from payment date so bookkeeping can reconcile them. Split payments are separate receipts; Stripe payouts are transfers and must not be counted again as customer revenue. These records support the user's bookkeeping rather than making automated tax-filing decisions.

### Monthly maintenance invitation and enrollment — required for first release

Reuse the existing Monthly Mini page and add a personalized enrollment path. The owner can opt in to sending an invitation per completed full detail, preview/edit approved template fields, or choose Send later. Never send it automatically to every client by default.

- Proposed interpretation of “within 60 days”: the client may enroll within 60 calendar days of that vehicle's completed full detail, not 60 days after payment/email delivery. Store an explicit eligibility deadline and display the last eligible date. Confirm separately if the first maintenance visit must also happen within that window.
- Send only when the qualifying full detail is complete and settled in full, including verified cash/Venmo/Cash App and cleared checks as well as Stripe. Never trigger on the $50 deposit, an unpaid payment link, or a work-completed toggle alone. A zero-dollar comped job needs an explicit owner eligibility exception rather than a fabricated payment.
- If the owner selected the invitation before payment, a single shared settlement event queues it once. If selected after payment, queue it immediately after eligibility checks. Recheck state, deadline, marketing preference, and suppression at send time; duplicate webhooks/edits cannot send duplicate invitations. Missing email creates a “needs email” action item, not a silently successful send.
- Email explains monthly service, verified vehicle-specific price, inclusions, eligibility deadline, and a direct “Join monthly maintenance” action. Keep promotional consent/preferences and unsubscribe handling separate from required booking/receipt messages. Do not add recurring reminder emails unless enabled by the owner.
- Enrollment records customer/vehicle, qualifying appointment, agreed monthly service/price, cadence, preferred availability, and status. Let the customer request the first available maintenance visit; owner confirms the schedule. Enrollment does not automatically reserve an unbounded series of slots or exempt every future booking from deposits; use the owner-set client preference.
- Launch provides monthly follow-up/next-visit tracking, enrollment status, and repeat-appointment creation with fresh checks against all three calendars. Future visit scheduling uses the owner's chosen calendar-month cadence, not an assumed 30-day interval. Decide last-day-of-month handling during configuration.
- Proposed billing default is per completed visit using the same payment link/external-method flow. Automatic subscription billing remains an explicit open choice; do not promise autopay, guaranteed monthly slots, or a long-term contract without configured terms and consent.
- Track eligible, invited, enrolled, first visit booked/completed, active, paused, and ended states plus invitation-to-enrollment conversion. Suppress duplicate offers for existing enrollees; refunds/disputes/returned payments before invitation invalidate automatic eligibility and create an owner review if enrollment already occurred.

### Installable admin PWA — required for first release

Provide an Android homescreen installation path with the business icon/name and standalone app experience. Use a dedicated admin manifest with stable identity, `/admin/today` start URL, `/admin/` scope, appropriate theme/background, and 192px/512px plus maskable icons. Link it from admin pages; retain the public site's separate entry experience. Provide an install affordance when supported and browser-menu instructions as fallback. Admin authentication/authorization remains required after install.

The existing service worker intentionally unregisters and reloads clients. Replace/migrate this behavior carefully: no blanket cache deletion, unregistration, or forced reload while an onsite form/payment operation is active. Version app assets, scope caches, and present “Update available” with a safe reload after saved work. Cache only the static shell and an offline explanation in the initial release; private appointment/financial responses stay network-only/no-store and sign-out clears any session-owned state. Disable Firestore persistent customer-data caching unless a separate device-security/offline design is explicitly added.

When offline, show connection state and preserve an already-open unsaved draft in memory, but never claim a note/payment was saved, confirm a slot, mark money received, or queue financial actions silently. Recover gracefully when connectivity returns. PWA installation does not imply full offline functionality. Test Android installed-app login, email/Google sign-in handoff, photo picker, share/copy/QR actions, deep links, back navigation, and restoration after app switching. Push notifications are optional later; email/Telegram remain the launch notification channels.

## 10. Content publishing and media

Offer structured editing, not an unrestricted drag-and-drop site builder. Keep design/layout components in code and expose useful fields, repeatable sections, and galleries.

Draft → authenticated preview → publish → generated/static update → visible deployment status. Retain content revisions and allow rollback. Published prices and policy versions must be traceable and consistent across quote pages, checkout, service pages, and receipts.

Extend the existing static blog workflow to render approved content snapshots. Trigger builds through a server-authorized, narrowly scoped mechanism; no GitHub/Firebase deployment credential reaches the browser. Show queued/building/live/failed states and retain the previous live version on failure.

Keep runtime booking prices authoritative on the server. During a content rollout, show the currently valid catalog version in the booking flow; existing requests retain their snapshots. Prefer a staged publication process that promotes a validated catalog/content release together. Operational availability changes take effect immediately without requiring a content build.

Upload validation includes MIME/size checks, safe filenames, image resizing, alt text, and restricted storage paths. Existing source image pipeline remains useful for site assets. Customer condition photos require private authorization, distinct storage rules, and removal/retention controls; do not publish them automatically into marketing galleries.

Deploy Storage rules explicitly; no Storage rules file is currently tracked. Verify bucket configuration in staging before enabling new upload paths. Keep URL redirects, canonical tags, metadata, structured data, sitemap generation, and image accessibility in the publication pipeline.

## 11. Data model and API outline

Retain `clients` IDs rather than creating a competing customer database. Separate account identity from a client record: a verified user may access only explicitly linked clients/appointments. Never automatically grant access to historical records solely because an entered email/phone matches unverified legacy data.

| Collection | Purpose / important fields |
| --- | --- |
| `clients` | Existing CRM contacts, Stripe Customer ID, operational profile, owner-controlled deposit default/trust decision and audit. Private notes remain separate from customer DTOs. |
| `customerAccounts` | Firebase UID, verified identity, linked sign-in providers, authorized client IDs, access/link history. Password credentials remain managed by Firebase Auth. |
| `vehicles`, `serviceAddresses` | Client ownership, vehicle metadata, validated address/service area. |
| `serviceCatalog`, `catalogVersions` | Prices in cents, durations, add-on constraints, bookability, public version. |
| `appointments` | Client/resource IDs, acquisition source and booking channel, source lead, UTC start/end, timezone, scope/price/policy snapshots, approval provenance, deposit requirement/waiver, payment deadline, nonrefundable lock, work completion, settlement and state/version. |
| `appointmentLinks` | Hashed capability token, appointment, limited permissions, expiry/revocation, share/send metadata; never plaintext token storage or public access to other records. |
| `jobRecords`, `priceRevisions` | Private onsite notes/checklists/photo references, work timestamps, estimate/final line items, upcharge reasons, approval evidence, save/version history. |
| `appointmentChanges` | Requested old/new schedule, acceptance, actor, status, reason. |
| `reservations` / resource-day locks | Held intervals, resource, owner appointment, hold type, expiry, reconciliation state. |
| `paymentObligations` | Deposit/final balance, expected amount, active checkout, quote version, settled status. |
| `payments`, `paymentAllocations` | Stripe/cash/check/Venmo/Cash App/other transactions, receipt/clearance states, method/reference, gross/known fees, actual versus recorded timestamps, deposit allocations, reversals/refunds, immutable money history. |
| `refundOperations`, `stripeEvents` | Idempotency, provider status, retries, event processing receipts. |
| `availabilitySettings`, `availabilityExceptions` | Weekly schedule, lead time/horizon, buffers, closed periods. |
| `calendarConnections`, `calendarSync` | Selected calendars, event mappings, sync cursors/channel expiry, connection health; tokens protected server-side. |
| `notificationOutbox`, `auditEvents` | Durable side effects, retry/dead-letter state, operational audit. |
| `maintenanceInvitations`, `maintenanceEnrollments` | Qualifying full-detail/vehicle, eligibility deadline, owner send choice, suppression/delivery state, enrollment/cadence/price snapshot, first/next visit, active/paused/ended status. |
| `siteContent`, `contentRevisions`, existing `blogPosts` | Structured content, drafts, publish snapshots and deployment status. |

Representative endpoints, names to finalize during implementation:

- Public/scoped: `GET /api/catalog`, `GET /api/availability`, `POST /api/booking-checkout`; appointment-link token exchange, scoped details/calendar export, and deposit/balance checkout. Never allow trust/waiver selection through unverified input.
- Customer authenticated: `GET /api/me/appointments`, `GET /api/me/appointments/:id`, `POST .../cancel`, `POST .../reschedule-request`, `POST .../accept-offer`, `POST .../balance-checkout`.
- Owner authenticated: `POST /api/admin/appointments/:id/approve`, `.../propose-alternative`, `.../decline`, `.../approve-reschedule`, `.../complete`, `.../record-payment`, `.../refund`.
- Owner creation/onsite: create appointment, set audited deposit requirement, create/revoke/send appointment link, save job notes/media, revise/approve final total, generate balance link, record/clear/reverse external payment, export payments, select/send maintenance invitation.
- Maintenance: authenticated/scoped invitation details and enrollment request; owner enrollment approval, pause/end, next-visit creation, and dashboard queries. Recheck eligibility on the server.
- Integrations: Stripe webhook, Google watch receiver, Google OAuth start/callback, transactional delivery callbacks.
- Existing lead APIs stay compatible; link lead → client → appointment without inventing a new lead on every payment retry.

Authenticated mutations require Firebase identity verification, ownership/role checks, input validation, idempotency keys, and expected record version. Scoped appointment-link access is revocable and limited to the identified appointment/details/payment operations; it is not account authentication. Payment/appointment changes are server-only. Rules tests explicitly reject cross-customer reads and all direct client writes to financial state, trusted defaults, and waivers.

## 12. Notifications, security, and operations

Email is a launch dependency, not a later cosmetic feature. Choose a transactional provider, authenticate the sending domain, configure reply-to, and verify delivery. Use Firebase email-link authentication or server-generated Firebase sign-in links delivered by that provider; use a supported web flow rather than deprecated Dynamic Links behavior.

Required messages: owner-created appointment details/deposit request, no-deposit confirmation, deposit received/pending approval or preapproved confirmation, owner-review reminder/escalation, approved/preparation, proposed alternative, customer change request, move confirmed, cancellation/refund status, upcoming appointment, final balance due, payment receipt, owner-selected maintenance invitation, integration failure. Include Add to calendar on relevant appointment emails. Reminders must be versioned/cancelled when dates or states change so obsolete jobs cannot send contradictory messages.

Recommended customer reminders: a policy reminder before the refundable cutoff (only if confirmed early enough) and a preparation reminder 24 hours before the job. Short-notice confirmation must immediately disclose the applicable cutoff. Use separate transactional and marketing preferences. Automated SMS is out of the launch scope; existing personal texting remains available.

Security and reliability requirements:

- Stripe/OAuth/email secrets in managed server secrets; never HTML, frontend JS, committed env files, logs, or chat. Only Stripe publishable configuration reaches the browser.
- Separate production, staging, and local/emulator configuration for Firebase, Stripe, Google calendars, email recipients, and webhook secrets. Existing hardcoded Firebase configuration must become environment-aware before staging customer data.
- Rate-limit checkout, availability, link requests, and guest request creation. Limit simultaneous unpaid holds; use abuse detection/App Check as appropriate.
- Sanitize structured content and uploaded media; protect against XSS/CSRF/open redirects as applicable to chosen auth transport.
- Use `no-store` for private responses, noindex account/admin/link pages, safe referrer handling, and no customer PII in URLs. Appointment-link tokens are sensitive capabilities: transport only through the scoped link exchange, remove before third-party loads, and exclude from logs/analytics/calendar exports. Verify Hosting headers/CSP and wallet requirements against the actual deployed origin.
- Maintain refund/chargeback evidence: accepted policy, exact price/scope version, payment record, notifications, consent, and appointment history.
- Define retention/anonymization for customer records and photos while preserving necessary transaction/audit records. Archive paid records instead of destructive deletion from existing admin tools.
- Monitor unpaid/paid state mismatches, pending-review age, failed refunds, webhook backlog, calendar freshness, email failures, and jobs approaching start without approval.
- Back up data, document restoration, set usage budgets/alerts, and provide a booking pause switch that still permits management, cancellation, and refunds.

Stripe's original processing fees are generally not returned on refunds under its documented refund behavior. The proposed full $50 customer refund should not silently deduct fees; account for this business cost. Verify actual account terms and any optional product fees before launch. This plan specifies product behavior, not a legal determination of policy enforceability or tax treatment.

## 13. Migration and rollout

1. Export/back up existing leads, clients, booking history, content, and rules. Inventory upcoming Google appointments and how each was booked/paid.
2. Add collections and compatible read paths. Do not replace client IDs or overwrite the existing lead APIs in one release.
3. Seed a versioned catalog from current server prices; reconcile static service copy and ambiguous legacy service names manually.
4. Import legacy history with provenance and `payment_status: unknown` unless payment is verified. Existing amounts are historical service values, not guaranteed collected revenue.
5. Import future legacy bookings as confirmed/manual records with correct calendar links and verified deposit/waiver state. Do not charge existing clients retroactively by default.
   Review/set trusted-client deposit defaults explicitly, and link imported upcoming bookings to the existing Detailing calendar without creating duplicate events. Preserve external payment methods/references where known; otherwise flag them as unknown. Do not infer trust, payment method, or maintenance eligibility from incomplete history.
6. Enable owner-only end-to-end testing in staging, then a small controlled production pilot.
7. Replace `/schedule` and all booking CTAs. Disable/retire the external Google appointment-schedule booking route, including shared off-site links, after legacy bookings are reconciled.
8. Expand to all configured services. Observe the first real deposit, approval, reschedule, balance, and refund through reconciliation.
9. Rollback pauses new checkout while existing webhooks, portal management, refunds, calendar sync, and balance records stay operational. Never roll back by deleting paid data.

## 14. Implementation work packages and release gates

| Stage | Deliverable | Gate |
| --- | --- | --- |
| 1. Foundation | Modular backend, environment isolation, catalog/policy model, roles/rules, ledger and lock design. | Authorization and money/state invariants tested. |
| 2. Booking and deposits | Public deposit checkout plus owner-created appointment links, trusted defaults/no-deposit bookings, slot/payment deadlines, signed webhooks and lifecycle. | All three booking paths work; no concurrent slot sale or fictitious deposit credit. |
| 3. Portal and lifecycle | Direct appointment details/payment/calendar links, email sign-in, optional password/Google linking, cancellation/reschedule/alternate offers and cutoff locking. | No mandatory password; account history stays consistent across sign-in methods; access/policy tests pass. |
| 4. Calendar and communications | Existing Detailing destination plus personal/Pluto busy checks, sync/recovery, appointment emails/Add to calendar, outbox/reminders/expiry. | All three calendars block slots; no duplicate events; failures recover; correct confirmations for each booking path. |
| 5. Onsite operations and retention | Mobile current-job flow, notes/photos/upcharges, online links and external/split payments/check clearing, exports, post-settlement maintenance invitation/enrollment. | One job can close entirely from Android, amounts/methods reconcile, and invitation sends only when eligible and selected. |
| 6. PWA, content and launch | Installable admin PWA/safe updates, structured content/media, publication, accessibility/performance, legacy booking cutover/pilot. | Android installed-app workflow works end to end; owner manages appointments and content without developer intervention. |

Stages describe dependencies, not a suggestion to publicly launch an incomplete lifecycle. The first public release must include owner-created shareable appointment/payment links, Add to calendar, trusted-client no-deposit confirmations, the mobile onsite/payment-method flow, optional post-payment maintenance invitation/enrollment, passwordless plus optional password/Google access, all three calendars, and the installable admin PWA. Core approval/cancellation/refund, communications, and recovery must work across those paths. Broader content CMS expansion can follow a controlled payment pilot; the newly requested operational features are not deferred enhancements.

This is a substantial product extension rather than a checkout-button change. Estimate implementation effort after the scheduling matrix, provider choices, and acceptance criteria are fixed; avoid promising a delivery date from repository inspection alone.

## 15. Acceptance tests

### Money and policy

- Pay $50 without prior approval; see pending, not confirmed. Approve once; receive exactly one confirmation.
- Cancel before approval at both ten days and ten hours ahead: full $50 refund.
- Confirmed cancellation at 96 hours + 1 second, exactly 96 hours, and 96 hours - 1 second gives the intended outcomes.
- A confirmed appointment crossing cutoff cannot become refundable by moving later, including when no cutoff worker ran.
- A pending paid request is still refundable inside the window; approval and cancellation racing produce one valid outcome.
- Reschedule does not create a second deposit; $300 job always subtracts the same $50 once.
- Owner/weather cancellation refunds even a locked deposit; confirmed no-show retains only the applicable deposit.
- Unapproved requests remain held after the 24-hour alert and auto-cancel/refund at start, with worker retries.
- Partial/failed refunds and Stripe Dashboard refunds reconcile correctly; notification says “initiated” until provider success.
- Owner-created required-deposit link confirms after payment without a second review; preapproved inside-cutoff terms are shown before payment. Expired owner reservation cannot collect until revalidated.
- Trusted-client appointment confirms/emails without checkout; $300 service leaves $300 due, not $250. Waiver after a collected deposit cannot erase payment/credit history.
- Unknown visitor cannot self-assign trusted status; changing a client's future deposit default does not silently alter an existing appointment.

### Payments and concurrency

- Duplicate submits, refreshes, two tabs, lost redirect, delayed/duplicate/out-of-order webhooks, and forged webhook signatures.
- Concurrent checkout for the same slot; expired hold with successful-but-delayed Stripe notification; external calendar conflict.
- Failed card, customer authentication challenge, wallet fallback, abandoned checkout, and Stripe outage.
- Owner records cash while balance checkout is active; expired/invalidated quote version cannot quietly collect the wrong amount.
- Retry after a crash between Stripe acceptance and local update does not duplicate a charge or refund.
- Cash, check, Venmo, Cash App, and other entries record method/amount/reference/time; partial/split payments and reversals reconcile with the invoice. Check received/cleared/returned states affect settlement correctly.
- Old payment link shows paid/current remainder after an external payment or final-price revision; duplicate taps and online/external races do not silently overcollect.
- CSV export separates gross receipts, refunds, known fees, net amounts, outstanding/check-pending amounts, and payout transfers without double-counting revenue.

### Onsite, maintenance, and PWA

- Open Today → start job → save notes/photos → add agreed upcharge → finalize total → send/copy/QR balance link or record external payment → receipt, entirely on a phone.
- Optional maintenance invite queues after completed-and-paid full detail for Stripe and verified external payments, not deposit/partial/unpaid/uncleared-check states. Duplicate settlement events send once.
- Test owner selects before versus after settlement, no email, unsubscribe, existing enrollment, refunds/returned checks, and eligibility at/beyond the 60-day boundary measured from job completion.
- Maintenance signup preserves vehicle/client/price, requests a valid first visit, and records monthly next-visit status; it never silently starts an auto-charge subscription or reserves conflicting future slots.
- Android installs/launches at admin Today, authenticates, handles app switching and sign-in redirects, and retains saved work. Pending updates never force-reload an unsaved job form.
- Offline shell clearly reports disconnected state; no payment/booking false success, private-response caching, or silent queued money writes. Failed note saves preserve an open draft and retry explicitly.

### Calendar, security, migration, and experience

- DST changes, all-day busy events, recurring busy events, travel buffers, multi-day services, and cross-midnight reservations.
- Revoked Google connection, expired watch channel, missed notification, invalid sync token, direct event deletion/edit, duplicate event retry.
- Cross-customer reads/writes, expired guest tokens, forwarded sign-in links, account linking, unverified legacy email, content-editor refund attempt.
- Existing quote/add-on/ceramic/Telegram regression suites remain green; legacy booking history is preserved without fabricated payments.
- Test mobile widths 320/390/768px and desktop, keyboard navigation, 200% zoom, focus management, reduced motion, readable errors, and 48px touch targets.
- Private pages are not cached/indexed; staging cannot call production payment/calendar/email systems.
- Publication failure leaves the old site intact; catalog/service pages/booking prices reconcile after successful publication.
- Existing Detailing, personal, and Pluto Events busy intervals each block availability; writes go only to Detailing. Legacy event mapping does not duplicate or double-block imported appointments.
- Shared appointment link opens without password, exposes only allowed fields, supports Add to calendar/payment, and obeys expiry/revocation. Exported calendars do not leak secret tokens.
- Optional password creation/reset, Google sign-in/provider linking, and email links retain one account/history; credential collisions do not merge unrelated records or grant admin/trusted status.

Use meaningful policy unit tests, Firebase emulator/rules integration tests, Stripe test-mode webhook flows, a test Google calendar, and end-to-end browser tests. Do not send real customer email or Telegram from automated tests. No tests were run for this planning-only change.

## 16. Remaining launch configuration and defaults to validate

The core workflow and policy are settled. These inputs remain intentionally open:

- Working days/hours, duration by service/vehicle/add-ons, travel/setup buffers, daily capacity, minimum lead time, booking horizon, and multi-day service behavior.
- Bookable duration/scope for “Other,” ceramic consultations, and custom-priced jobs; do not collect money against an unconfigured time block.
- Exact supported service area, travel fees if any, and water/electricity/shelter requirements.
- Exact IDs/access for the existing Detailing, personal, and Pluto Events calendars; owner-only sync conflict handling is the recommended launch rule.
- Transactional email provider and authenticated sender; exact reminder/escalation timings.
- Alternate-offer acceptance deadline and price-change acceptance screens; proposed defaults are documented above.
- Default expiration of owner-created unpaid appointment links (24 hours proposed; shorter/manual for near-term work), and which existing clients receive an owner-approved deposit waiver.
- Monthly Mini's confirmed prices/durations/inclusions, whether the first visit as well as enrollment must occur within 60 days, monthly cadence/month-end rules, and whether billing stays per visit or needs separately authorized automatic subscriptions. Enrollment within 60 days of full-detail completion is the current stated planning assumption.
- Approved customer-facing policy copy, invoice/receipt business identity, any applicable tax setup, privacy/retention settings.
- Whether to add optional tips, terminal payments, automated SMS, automatic subscription billing, gift cards, route optimization, full offline job-data persistence, or public instant approval later. These are not required by the current launch plan; maintenance invitation/enrollment and the installable admin PWA are required now.

Credentials can come later through local/managed secret configuration. Required setup: Stripe test/live publishable and secret credentials plus webhook secrets; Google OAuth client and Calendar API; email-provider credentials; production/staging Firebase configuration. Never commit private keys or ask clients to provide card details to the website's own server.

## 17. Primary documentation consulted

These sources inform the technical choices; recheck versions and account-specific configuration during implementation.

- Stripe Checkout overview: https://stripe.com/payments/checkout
- Checkout Session creation and expiry limits: https://docs.stripe.com/api/checkout/sessions/create
- Stripe webhook signatures, delivery, ordering, and retries: https://docs.stripe.com/webhooks
- Stripe refunds and processing-fee behavior: https://docs.stripe.com/refunds
- Firebase email-link authentication: https://firebase.google.com/docs/auth/web/email-link-auth
- Firebase managed function secrets: https://firebase.google.com/docs/functions/config-env
- Google server-side OAuth: https://developers.google.com/identity/protocols/oauth2/web-server
- Google Calendar free/busy: https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
- Google Calendar push channels and renewal: https://developers.google.com/workspace/calendar/api/guides/push
- Google Calendar incremental synchronization: https://developers.google.com/workspace/calendar/api/guides/sync
- Firebase account-provider linking: https://firebase.google.com/docs/auth/web/account-linking
- Firebase Google sign-in: https://firebase.google.com/docs/auth/web/google-signin
- Chrome web-app installation: https://developer.chrome.com/docs/modern-web-guidance/guides/pwa/install-web-app
