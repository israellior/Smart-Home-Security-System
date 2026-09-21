# Porchlight API

Express + MongoDB (Mongoose) + JWT backend for the Porchlight frontend.
Replaces the old localStorage-only settings with a real account system:
register/login, and each user's doorbell settings and activity events
live in a database instead of the browser.

## Setup

**1. Get a MongoDB database.** Two options:

- **Easiest for Windows: MongoDB Atlas (free tier, cloud-hosted).**
  Sign up at https://www.mongodb.com/cloud/atlas, create a free (M0)
  cluster, add your current IP to the access list, create a database
  user, and copy the connection string it gives you (looks like
  `mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/porchlight`).
  This avoids installing anything locally.

- **Local install.** Download MongoDB Community Server from
  https://www.mongodb.com/try/download/community, install it (it can
  run as a Windows service, started automatically), and use
  `mongodb://127.0.0.1:27017/porchlight` as your connection string.

**2. Configure environment variables.** Copy `.env.example` to `.env`
and fill in `MONGODB_URI` with whichever connection string you got
above. Generate a `JWT_SECRET` with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

and paste the output in as `JWT_SECRET`.

**3. Install and run:**

```
npm install
npm run dev
```

`npm run dev` uses Node's built-in `--watch` flag, so the server
restarts automatically when you edit a file. You should see:

```
MongoDB connected
Porchlight API listening on http://localhost:4000
```

If you instead see a connection error, double check `MONGODB_URI` in
`.env` and (for Atlas) that your current IP is on the cluster's access
list.

## API overview

All routes are prefixed with `/api`. Routes marked (auth) require an
`Authorization: Bearer <token>` header with the JWT returned by
register/login.

| Method | Path                          | Description                        |
|--------|-------------------------------|-------------------------------------|
| GET    | `/health`                     | Liveness check                      |
| POST   | `/auth/register`              | `{ name, email, password }` → token |
| POST   | `/auth/login`                 | `{ email, password }` → token       |
| GET    | `/auth/me`             (auth) | Current user                        |
| GET    | `/devices`              (auth)| Devices you're a member of, each with your `role` |
| POST   | `/devices`              (auth)| Create a device — you become its owner |
| POST   | `/devices/join`         (auth)| `{ shareCode }` → join a device. **First joiner becomes its owner** |
| GET    | `/devices/:id`          (auth)| One device (must be a member)       |
| PATCH  | `/devices/:id`          (auth)| Update name/location/sensitivity (shared by all members) |
| PATCH  | `/devices/:id/preferences` (auth) | Your own notification preferences for this device |
| POST   | `/devices/:id/seen`     (auth)| Mark the activity list as read (moves your watermark) |
| DELETE | `/devices/:id`          (auth)| Delete a device — **owner only**, cascades events + memberships |
| GET    | `/devices/:id/members`  (auth)| Who has access, and in what role    |
| DELETE | `/devices/:id/members/:userId` (auth) | Remove someone (owner) or leave (yourself) |
| GET    | `/devices/:deviceId/events` (auth) | Events, newest first. `?limit=` (max 100) and `?before=<cursor>` |
| POST   | `/devices/:deviceId/events` (auth) | Log an event: `{ type, meta, eventId?, at? }` → `{ event, outcome }` |
| GET    | `/devices/:deviceId/self` (device) | What the Pi can see about itself. Device credential, not a JWT |

Routes marked **(device)** authenticate with a *device credential*
(`Authorization: Bearer pl_porch-1_…`), not a user JWT. The two are separate
principals and neither is accepted where the other is expected.

**Every route authenticates.** There is no enrolment endpoint and no
unauthenticated route anywhere in the app — devices are provisioned offline,
not over the wire.

### Sharing model

Access lives in a `Membership` collection — `{ device, user, role }` — rather
than an `owner` field on the device. That's what lets one household share a
doorbell and one account hold several. A compound unique index on
`{ device, user }` makes joining idempotent: a double-tapped button can't
grant two memberships.

- **owner** — created the device in the app, or was the first to claim a
  provisioned one with its share code. Can rename, delete, and manage access.
  Sees the `shareCode`.
- **member** — joined a doorbell that already had an owner. Can view and
  change settings. Cannot delete the device, remove other people, or see the
  share code.

Exactly one owner per doorbell, enforced by a partial unique index rather than
a check — see "Claiming" below for why that matters.

The owner cannot leave a device (there'd be nobody left to manage it) — they
delete it instead. Transferring ownership isn't built yet.

Share codes look like `PORCH-7K2M9P`, generated with `crypto.randomInt` over
an alphabet that omits `0/O` and `1/I/L`, since these get read aloud. Input is
normalized, so `porch 7k2m9p` and `7K2M9P` both work.

## Hardware identity and provisioning

**A doorbell is born with its credential and takes no part in deciding who
owns it.** It is provisioned once, when the hardware is built, by an operator
running a script. It never enrols over the network, never negotiates for a
secret, and never waits for a person. It boots, authenticates, and starts
reporting — whether or not anyone has claimed it yet.

That split is the whole design: **authentication** answers "is this a real
doorbell", **ownership** answers "whose is it", and only the second involves a
human. A doorbell that comes up at 3am reports motion at 3am.

### Provisioning

```
node scripts/mint-device.mjs --device-id porch-1 --name "Front Door"

  credential   pl_porch-1_xK3mQ9…      write this onto the Pi
  share code   PORCH-7K2M9P            give this to whoever will own it
```

Two secrets, printed once each, with completely different jobs:

| | grants | to whom | lifetime |
|---|---|---|---|
| **credential** `pl_porch-1_…` | "I am porch-1", on every request | that Pi | until re-minted |
| **share code** `PORCH-7K2M9P` | access to this doorbell | any *person* | until revoked |

`--force` re-mints: the new credential replaces the old one, which stops
working the instant it saves. That is the recovery path for a lost credential
and the revocation path for a Pi that walked off. There is deliberately **no
rotate-over-the-network endpoint**, so this means re-flashing the card — a
conscious trade of convenience for having no remote path to a device's
identity.

`--attach <id>` binds hardware to a doorbell that already exists in the app,
rather than creating a new record. Its share code and members are untouched.

### Claiming: first joiner becomes the owner

A minted device has **no owner at all**. The first person to submit its share
code becomes `owner`; everyone after is a `member`.

Two people submitting the same code in the same instant would both read "no
owner yet" and both become owner, so this is enforced by a **partial unique
index** on `{ device, role: 'owner' }` rather than by a check — the loser's
insert fails and `joinDevice` retries them as a member. Same reasoning as the
share code's own unique index: a uniqueness rule that matters is enforced by
the database or it is not enforced at all. Verified with 8 simultaneous
claims: one owner, seven members, nobody rejected.

The trade-off worth knowing: whoever holds the share code first owns the
doorbell, so a code that leaks before its intended owner uses it is a
land-grab. That is the cost of having no separate claim code, and it closes
the moment someone claims.

### Events arrive before owners exist

An unclaimed doorbell's alerts are stored normally. The notification fan-out
finds zero members and returns early; nothing errors and nothing is lost. When
someone finally claims it, `lastSeenAt` is `null` — meaning "never looked" —
so the entire history counts as unread and they see everything that happened
before they arrived.

This is rule 4's order independence generalised to ownership, and it needed no
code: the watermark already said the right thing.

### Secrets are stored hashed and shown once

Only hashes are persisted, and the schema's `toJSON` strips `credentialHash`
on every path out, the same way `User` strips `passwordHash`. There is no
endpoint that reads a credential back — not for the owner, not for the device.

**SHA-256, not bcrypt**, for device secrets. bcrypt is slow to make guessing a
*human-chosen* password expensive; a device credential is 32 bytes from the
CSPRNG, where there is no dictionary and stretching buys nothing. The slowness
would cost ~100ms on every media-token mint, clip upload and socket reconnect
in the fleet. Passwords keep bcryptjs — the rule is about the secret's
entropy, not the collection.

**The deviceId rides inside the credential** (`pl_<deviceId>_<secret>`), so
authenticating is one indexed lookup plus one hash rather than a comparison
against every device row — the same reason GitHub and Stripe keys are prefixed
rather than opaque. Parsing scans left to right: base64url's alphabet includes
`_`, so splitting from the right would cut the secret in half.

### Three states, and they are not the same question

- **provisioned** — a Pi was built for this doorbell and holds a credential.
- **claimed** — at least one person has an owner Membership for it.
- **connected** — a Pi is on the other end of a socket *right now*.

All three are independent. A doorbell can be provisioned, unclaimed and
online, reporting alerts nobody is reading yet.

### `req.hardware`, not `req.device`

`requireDeviceAccess` already puts a device on `req.device`, meaning "one this
*user* may touch". The two middlewares authorize against different principals,
and a handler reading the wrong one would be checking the wrong thing
entirely.

## Events: the device's contract

An event's identity belongs to the device, not to us. `porchlightd` mints an
`eventId` when the sensor fires and **resends that alert until it is
acknowledged**, so retries are the normal case rather than the exception. Four
rules follow from that, and all four live in exactly one place —
`services/events/ingestEvent.js`. Both the HTTP endpoint and (next) the
signaling socket call it, because two implementations of the upgrade rule is
how a ring silently becomes a motion on whichever path got it wrong.

**1. Dedupe on `(device, eventId)`.** Enforced by a unique index, not by a
check — a check loses the race it exists to prevent. Verified: 90 concurrent
posts of 30 distinct events produced exactly 30 rows and 60 duplicates.

**2. `motion` → `ring` is an upgrade; `ring` → `motion` is ignored.** Written
as a maximum, never a sequence, because after an outage the two can arrive in
either order. The kind is stored as `kindRank` (0/1) so the upgrade is an
atomic compare-and-set on a number; `type` is a virtual derived from it, so
there is no second copy to drift. `$max` on the *string* appears to work —
`"ring" > "motion"` — which is a coincidence that survives exactly until
someone adds a third kind.

**3. A rejection is permanent; a transient failure is not.** `ok: false` makes
the device **drop that alert forever**, so it is only ever returned for things
that will still be wrong next time: an unknown kind, a malformed timestamp.
Anything transient — a database blip, a deploy — must produce *no answer at
all*, because a missing acknowledgement is the retryable case. `ingestEvent`
encodes this in its signature: permanent problems are **returned** as
`REJECTED`, transient ones are **thrown**.

**4. Order independence.** Nothing requires anything else to have arrived
first. `at` is applied with `$min`, so whichever of the motion and the ring
lands first, the event keeps the earliest sensor time.

### Two timestamps, and why neither is optional

| | means | used for |
|---|---|---|
| `at` | when the sensor fired | display, ordering, cursor paging |
| `receivedAt` | when we last learned something new | unread counts |

They differ exactly when it matters most. An alert a doorbell held through a
ten-minute outage carries an *old* `at` — so the activity list shows it at the
time someone was actually at the door, which is right. But counting unread by
`at` would file it below the watermark and mark it read **before anyone saw
it**. Counting by `receivedAt` is what stops the one alert you most wanted
from being the one that goes unnoticed. The UI tags such a row `delayed`, so a
backfilled event isn't quietly buried in yesterday.

`outcome` on the response is `created` | `upgraded` | `duplicate`, and 201
only for `created` — telling a device replaying an hour of backlog that it
"created" something several hundred times would be a lie.

## Signaling (`/signal`)

A WebSocket sharing the API's port — one origin, one deployment, no second
CORS story. It carries alerts **up** from the doorbell, viewer requests
**down** to it, and new events **out** to anyone with the activity list open.
It does not carry media; that is the SFU's job.

Every connection opens with a `hello` and is closed after ten seconds if it
doesn't send one.

| role | who | authenticates with |
|---|---|---|
| `device` | `porchlightd` | device credential |
| `pi` | `webrtc-video.py` | device credential |
| `browser` | a person watching | user JWT, membership checked **at connect** |

### The role trap

`webrtc-video.py` already signs in as `role: 'pi'`, and the device repo's LAN
stub treats *any* second `pi` hello as a replacement — it closes the first
socket. So `porchlightd` gets its own role, and replacement is scoped per
role: a reconnecting daemon displaces only the previous daemon.

Give the daemon `'pi'` instead and every reconnect silently kicks the media
script off its socket. That presents as video randomly failing rather than as
an auth problem, so it would be debugged in entirely the wrong place. There is
a test named after this specifically.

### Rule 3 on the socket, where it actually bites

Over HTTP a 500 was self-correcting. Here, `ok: false` makes the device
**discard a real doorbell press forever**. So the handler sends:

- `event-ack { ok: true }` — stored (or already stored, or upgraded)
- `event-ack { ok: false }` — permanent: unknown kind, unparseable timestamp
- **nothing at all** — transient: the database blipped, a deploy is mid-flight

The ack echoes the kind that was **sent**, not the kind now stored. The device
dedupes its own outbox by `(eventId, kind)`, so acknowledging a motion as
"ring" because a later press upgraded the record would leave that motion
looking unsent forever.

The same distinction exists at connect time: a rejected credential closes with
`4002`, a transient failure closes with `1013 Try again later`. A client that
retries the first is a client in an infinite loop.

This was tested against the real failure mode rather than a mock. A 40-event
backlog flushed at once over the socket had **7 acknowledged and 33 dropped
transiently — and zero rejected**. Three retry rounds later: 40 acknowledged,
exactly 40 rows, no duplicates, kinds and sensor times intact. Silence is only
correct because the device retries; confusing it with rejection would have
lost 33 real events.

### Presence

`Device.connected` is finally written, and it means *right now*. Ping/pong
every 30s is what makes that true — a doorbell that loses power never closes
its socket, it just stops answering, and without heartbeats the app would show
"Connected and watching" forever.

Two subtleties, both load-bearing:

- **A restart resets every `connected` flag.** Whatever the database last
  recorded, nothing is connected to a process that just started. (This assumes
  one app server; with two, presence would need keying per instance, or one
  booting would wipe the other's live connections.)
- **A displaced socket's close does not mark the device offline.** The old
  socket's `close` arrives *after* the new one registered, so the registry
  only clears an entry that is still its own. Without that guard a reconnect
  would report as a disconnect and flap the UI.

### Live updates

New events are pushed to browsers watching that doorbell, so the activity list
updates without a refresh. It fires on `created` and `upgraded` and never on
`duplicate` — a doorbell flushing an hour of retries must not strobe everyone's
screen. Ingest publishes to an in-process `eventBus` rather than importing the
socket registry, so the rules stay testable without a server.

## Notifications

Two different things, deliberately kept apart:

- **Seeing** an event — everyone with access sees every event in the activity
  list. Shared, unfiltered, stored once.
- **Being notified** about it — opt-in, per person, per doorbell, pushed out
  to a phone or an inbox.

Because the event is already shared and stored once, there is no per-user
notification row duplicating its content. At 100k devices × 50 events/day
that would be four times the writes and storage to say nothing the event
list doesn't already say.

**Unread** is a watermark, not a flag. `Membership.lastSeenAt` is one
timestamp; "new events" is a range scan on the `{ device, createdAt }` index
Event already has. That's O(1) storage per person-per-device instead of
O(events × members). `GET /devices` folds every device's count into a single
aggregation rather than one count query per device.

**Dispatch** (`src/services/notifications/`) costs a fixed three queries no
matter how many members a device has: memberships with the preference on,
all their push subscriptions in one `$in`, then one `insertMany` for the
delivery log. It is never awaited — recording that motion happened is the job
that matters, and telling people is best-effort on top. That call site is
where a job queue slots in at real volume, without callers changing.

**It fires on `created` and `upgraded`, never on `duplicate`.** That rule
lives inside `ingestEvent` rather than at each call site, because it is part
of the dedupe rule and not a thing each transport should be trusted to
remember. Both halves matter: a doorbell flushing an hour of retries must not
re-notify anyone, and a ring arriving after its motion **must**, because it is
new information with its own per-person preference.

**Channels** (`src/services/notifications/channels/`) are `webPush` and
`email`. Both are **stubs**: they resolve recipients, honour preferences, and
log an honest `skipped` reason rather than pretending to succeed. Each names
in its header exactly what finishing it requires. Nothing else has to change.

**`NotificationDelivery`** records one row per attempt — a pointer plus an
outcome, not a copy of the content. It exists to answer "why didn't I get an
alert?", which is otherwise unanswerable: preference off, no subscription,
provider rejected it, or channel not configured are four different rows. A
TTL index prunes them after 30 days with no cron job.

**Events are paged by cursor**, never `skip`/`limit`. `.skip(n)` makes Mongo
walk and discard n documents, so page 1000 costs a thousand times page 1. The
cursor encodes `at` *and* `_id`, because a motion detector firing several
frames in one second produces events sharing a timestamp, and `at` alone would
skip or repeat them.

## Where this connects to the embedded (C/V4L2) side of the project

`POST /devices/:deviceId/events` is the endpoint the Raspberry Pi's
`v4l2_motion_detect.c` program could eventually call once it detects
motion on real hardware - e.g. via `libcurl` or a lightweight HTTP
client, sending `{ "type": "motion", "meta": { "pixelsChanged": 2240 } }`.
That's a deliberate seam: the frame-differencing logic on the device
stays simple C/V4L2 code, and "what happens with a detected event"
(storing it, notifying a user, showing it in the app) is entirely the
backend's job.

That gap is mostly closed now. Devices have their own credentials and their
own middleware (`middleware/deviceAuth.js`), and events carry the device-owned
identity and the dedupe/upgrade rules the daemon expects — see "Hardware
identity and provisioning" and "Events: the device's contract" above.

The gap is closed. Real hardware connects to `/signal` with its own
credential, reports events there, and is acknowledged per the contract — see
"Signaling" above. `POST /devices/:deviceId/events` still requires a user's
JWT and stays that way deliberately: it is the app's path and the one tests
use, and it runs through the same `ingestEvent`, so the two transports cannot
disagree about a rule.

What is left is media (LiveKit tokens) and clips (pre-signed uploads).
`viewer-requested` is already delivered to the device; nothing answers it yet.

## Project structure

```
server.js                    - entry point: connect, indexes, presence, listen
src/
  app.js                     - Express app: middleware, routes, error handler
  signaling/                 - the WebSocket: registry, hello auth, frames
  config/db.js               - Mongoose connection + ensureIndexes
  models/                    - User, Device, Event, Membership, ... schemas
  middleware/auth.js         - JWT verification (requireAuth)      -> a user
  middleware/deviceAuth.js   - device credentials (requireDevice)  -> a Pi
  middleware/deviceAccess.js - "may this user touch this device?"
  controllers/               - request handlers, one file per resource
  routes/                    - route tables, wired to controllers
  services/events/           - ingestEvent: the only way an event gets in
  services/notifications/    - fan-out to push and email, plus the log
  utils/shareCode.js         - person-to-person access codes
  utils/deviceCredential.js  - device credentials: mint, parse, verify
scripts/mint-device.mjs      - provision hardware; the only credential source
scripts/migrate-*.mjs        - one-off migrations, all --dry-run capable
```

## Notes on choices made here

- **bcryptjs instead of bcrypt** - pure JavaScript, no native compiler
  toolchain needed. Slightly slower, but avoids "node-gyp" build
  headaches that native bcrypt sometimes hits on Windows.
- **express-async-errors** - Express 4 doesn't automatically catch
  a rejected promise thrown inside an `async` route handler; without
  this package, a database error would crash the whole process instead
  of returning a 500. It's imported once in `app.js` and after that
  every controller can just be a plain `async function` with no
  try/catch boilerplate.
- **Same error message for "no such user" and "wrong password"** on
  login - returning different messages would let someone probe which
  emails have accounts (a real security consideration, not just
  paranoia). The same reasoning is why a device you're not a member of
  returns 404 rather than 403: 403 would confirm the id is real.
  Owner-only actions *do* return 403, because there the caller can
  already see the device - there's nothing left to hide, only a
  permission to deny.
- **Schema-level `toJSON` transforms** on every model strip `__v`, and
  `passwordHash` on User. Doing it in the schema rather than per
  response means it holds no matter how a document reaches the client -
  including through `.populate('user')`, which the members list uses and
  which would otherwise hand back a full user document.
- **JWTs in `localStorage`, not an httpOnly cookie.** The usual advice
  is the cookie, which protects the token from XSS exfiltration. This
  app has close to no XSS surface (React escapes by default, no
  `dangerouslySetInnerHTML`, three runtime dependencies, no third-party
  scripts), and its realistic threat is a shared or stolen laptop -
  which a cookie doesn't help with either, since it persists the same
  way. The cookie's cost is real: CORS credentials, CSRF handling, flags
  that differ dev vs prod, and logout becoming a server round-trip.
  Revisit this the day any third-party script or user-generated markup
  gets rendered.
- **Retried Mongo connection on startup** (`config/db.js`) - the initial
  TLS handshake to this Atlas cluster fails intermittently with a
  server-side alert (not credentials, not the IP allowlist). Without a
  retry, `npm run dev` fails to start a good fraction of the time.
- **Indexes are awaited before the port opens** (`ensureIndexes`). Mongoose
  builds indexes on its own, but in the background at model-compile time, and
  it reports failures on an `'index'` event nothing listens to. So a fresh
  process serves requests during the window before its unique indexes exist -
  and every unique index here enforces a rule with no other enforcement: one
  doorbell per `deviceId`, one membership per `(device, user)`, one share code
  in the world. This was not theoretical. An end-to-end run had two doorbells
  successfully provision under the same `deviceId`, and the damage outlives
  the window: the duplicate rows persist, and the unique index can then never
  finish building. Every check had passed.
- **`maxPoolSize` is capped at 10.** The driver defaults to 100 and opens
  connections on demand, so a burst of concurrent requests means a burst of
  TLS handshakes — and on this cluster one failing handshake clears the whole
  pool and kills every operation in flight. A simulated doorbell flushing an
  hour of backlog saw 86 of 90 requests fail that way. Capping the pool cut it
  to a fraction; it is damage control, not a cure, and it is also just correct
  sizing. Raising this number is not how you serve more traffic, it is how you
  open more sockets to fail. What makes the rest survivable is the contract:
  no acknowledgement means the device sends it again.
- **Index builds run one model at a time, each retried.** Against this cluster
  a single failed handshake clears the whole connection pool, failing every
  operation in flight - so a `Promise.all` over six models turns one unlucky
  handshake into six failures, and retrying the batch re-rolls all six
  together. Five consecutive attempts failed that way before it was
  serialised. Sequentially a failure costs one model one retry. They are
  no-ops once the indexes exist, so it costs nothing worth measuring.
