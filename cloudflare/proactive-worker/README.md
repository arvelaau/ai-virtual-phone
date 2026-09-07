# Proactive Message 2.0 — Cloudflare Worker

This is a standalone Cloudflare Worker, deployed to your own Cloudflare
account. It is separate from the main Next.js app — it has its own
`wrangler.toml` and no build step (the Worker source is plain JavaScript).

See `PROACTIVE-MESSAGE-2.0-PLAN.md` at the repo root for the full design.
Stage 2 scope: this Worker can receive a push subscription, send a manual
test push, and report whether its Cron Trigger is firing. It does not yet
generate real per-character proactive messages (Stage 3/4).

## Option A — one-click deploy (recommended)

Use the "Proactive Push" section in the app's Settings. Paste a Cloudflare
API Token scoped to `Workers Scripts:Edit`, `D1:Edit`, `Account Settings:Read`
and the app creates the D1 database, uploads this Worker, sets the secrets,
and registers the Cron Trigger for you.

## Option B — manual deploy

If you'd rather not paste a Cloudflare API token into the app, or want to
inspect/customize the Worker before it goes live:

```bash
npm install -g wrangler   # if you don't already have it
cd cloudflare/proactive-worker

wrangler login

# Create the database, then paste the returned database_id into wrangler.toml
wrangler d1 create ai-phone-proactive
wrangler d1 execute ai-phone-proactive --remote --file=schema.sql

# Generate a VAPID keypair if you don't already have one from the app's
# Settings > Proactive Push > Push Credentials section, and paste the public
# key into wrangler.toml's [vars] VAPID_PUBLIC_KEY.
wrangler secret put VAPID_PRIVATE_KEY
wrangler secret put ACCESS_TOKEN   # any random string you also paste back into the app

wrangler deploy
```

After deploying, copy the Worker's URL and the `ACCESS_TOKEN` you chose into
the app's Settings > Proactive Push page so it knows where to register your
device's push subscription.

## Endpoints

All require `Authorization: Bearer <ACCESS_TOKEN>`.

- `POST /subscribe` — body `{ endpoint, keys: { p256dh, auth } }` (a
  `PushSubscription.toJSON()`). Registers/updates one device's subscription.
- `POST /snapshot` — body `{ characterId, snapshot }`. Upserts one
  character's proactive-message data package (persona, memory, prompt
  templates, etc. — see `lib/proactive-cloud-sync.ts`). Nothing reads this
  yet in Stage 2/3; Stage 4 wires the Cron Trigger to actually use it.
- `POST /snapshot/delete` — body `{ characterId }`. Deletes that character's
  snapshot and any queued state/messages — called when the app's user turns
  off cloud sync for a character.
- `GET /pending-messages` — returns every proactive message generated since
  the app was last open: `{ messages: [{ id, characterId, content,
  createdAt }] }`. The app merges these into local chat history and then
  calls `/pending-messages/ack` — the push notification alone is not the
  message; this is what actually puts it in the chat thread.
- `POST /pending-messages/ack` — body `{ ids: [...] }`. Deletes the given
  pending messages once the app has merged them locally, so they aren't
  delivered again.
- `POST /test-push` — sends a test notification to every registered
  subscription right now. Returns `{ sent, failed, errors }`.
- `POST /run-now` — runs one cron-tick's worth of eligibility checking and
  firing immediately, for every synced character, instead of waiting for the
  schedule. Same logic the Cron Trigger runs. Returns
  `{ processed, fired, errors }`.
- `GET /status` — returns `{ lastCronRunAt, lastCronSummary, lastCronError,
  subscriptionCount, snapshotCount }` so you can confirm the Cron Trigger is
  actually running and see what it did on its last tick, without needing
  `wrangler tail`.

## What the Cron Trigger actually does

Every 15 minutes (`processDueProactiveMessages` in `src/worker.js`), for each
synced character: checks its timed-wake schedules, then its follow-up
schedule, then period-care, in that priority order, and fires **at most one**
per character per tick (deliberate — avoids bursting several notifications
for one character in the same window). "Firing" means: call the character's
bound LLM with the pre-assembled prompt template from the snapshot, store the
reply in `pending_messages` (picked up by the app next time it opens), and
send a Web Push notification. Firing state (which schedule/cycle was already
handled) lives in `proactive_state`, separate from the synced snapshot, so a
stale snapshot can't cause a duplicate notification.
