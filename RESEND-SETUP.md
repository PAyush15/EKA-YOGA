# Resend booking email setup

Receiving is not required. Keep receiving disabled unless you separately want Resend to process inbound messages. Customer replies go to EMAIL_REPLY_TO (or ADMIN_EMAIL), which should be an existing working inbox. Do not replace existing inbox MX records to enable sending.

## Before merging the Resend PR

In Cloudflare → Workers & Pages → yoga-by-krunali → Settings → Variables and Secrets, add these to the production Worker's runtime configuration (not only Build variables):

| Name | Type | Value |
| --- | --- | --- |
| RESEND_API_KEY | Secret | Sending API key created in Resend; restrict to the verified domain |
| EMAIL_FROM | Variable | Yoga by Krunali <bookings@yogabykrunali.com> if yogabykrunali.com is the verified domain |
| ADMIN_EMAIL | Secret | Instructor's existing inbox, previously configured in Apps Script |
| EMAIL_REPLY_TO | Variable | Optional existing inbox for customer replies; defaults to ADMIN_EMAIL |
| RESEND_WEBHOOK_SECRET | Secret | Signing secret from the webhook configured below, beginning whsec_ |

If you verified a subdomain instead, EMAIL_FROM must use that subdomain. Creating the API key in Resend alone is insufficient: its value must also be saved in Cloudflare. Never commit keys or send them in a PR/comment/chat.

Save/deploy the settings. Merge the PR and let Cloudflare finish deploying main. No manual schema.sql execution is required: additive tables are created by the Worker automatically. Existing bookings, addresses, payments and email history are preserved. The keep_vars setting is repaired to preserve dashboard variables; secrets remain secrets.

## Delivery tracking

In Resend → Webhooks → Add webhook:

- Endpoint: https://yogabykrunali.com/api/webhooks/resend
- Events: email.sent, email.delivered, email.delivery_delayed, email.bounced, email.failed, email.complained, email.suppressed
- Copy the signing secret into Cloudflare RESEND_WEBHOOK_SECRET and deploy the setting.

This endpoint verifies the raw-body HMAC signature and a five-minute timestamp tolerance before saving anything. Duplicate callbacks are ignored. Event IDs, provider email IDs, types and timestamps are retained; full webhook bodies are not stored. Callbacks arriving before API acceptance is saved are retained. A late sent/delayed event cannot hide a delivered or adverse outcome.

## Behavior and migration

The Worker now sends directly to Resend, without Apps Script or fallback between providers. Existing NOTIFY_WEBHOOK_URL/NOTIFY_SHARED_SECRET may remain temporarily but are unused by this version. Keep them until testing is complete if you need to roll back.

Each reservation/confirmation has separate customer and instructor delivery records. Exact request payloads are retained in private D1 while pending so retries use identical bytes and idempotency keys; payloads are cleared after API acceptance. No payloads or credentials are returned to the admin API or public endpoints.

Transient errors retry with increasing delays, up to six hours between attempts, via the existing five-minute cron. Explicit quota rejections can retry beyond a daily reset (up to 16 attempts). A network timeout is ambiguous: retries use the same key, and automated retries stop after 23 hours, before Resend's 24-hour idempotency retention expires. Such records require checking Resend before any manual resend. Retry unsent emails never resends accepted messages or bypasses that guard.

If payment is recorded before an initial payment-request email is sent, its status explicitly says that payment confirmation replaces it. Accepted initial emails remain recorded; uncertain prior attempts require review. Cancelled bookings do not send new notifications. Already accepted messages cannot be recalled.

Already completed Apps Script jobs are not resent. Old attempted-but-incomplete Apps Script jobs become Needs review because either recipient might already have received mail. Old failed/skipped history is preserved. Check Apps Script/Resend history and contact the recipient manually where necessary; the application deliberately does not offer a blind resend for uncertain deliveries.

## Testing after deployment

1. Use your own test email to book a valid future slot. Check the entered address appears in both emails and the admin booking.
2. Confirm both customer and instructor reservation messages appear in Resend. Refresh admin: each should move from Accepted by Resend to Delivered to recipient mail server after the webhook.
3. For this test booking only, choose Mark paid. Confirm both confirmation messages arrive. Do not mark real unpaid bookings as paid.
4. Refresh/retry: accepted messages must not be sent again. Check the webhook endpoint's successful deliveries in Resend.
5. Cancel the test booking to release the slot. Cancellation does not send an email.

Delivered means the recipient's mail server accepted it, not guaranteed inbox placement. Check spam folders if necessary. Resend's event details provide further diagnostics; the admin page gives the provider email ID for correlation. Bounces/suppression/complaints are not automatically resent.

Automated local tests (mocked external mail, SQLite-backed):

    node --experimental-sqlite tests/smoke.mjs
    node --experimental-sqlite tests/resend.mjs

Live sending and dashboard configuration require the production runtime secrets and access to your Resend/Cloudflare accounts. They are not verified by the local tests.
