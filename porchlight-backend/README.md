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
| POST   | `/devices/join`         (auth)| `{ shareCode }` → join someone else's device as a member |
| GET    | `/devices/:id`          (auth)| One device (must be a member)       |
| PATCH  | `/devices/:id`          (auth)| Update name/location/sensitivity (shared by all members) |
| PATCH  | `/devices/:id/preferences` (auth) | Your own notification preferences for this device |
| POST   | `/devices/:id/seen`     (auth)| Mark the activity list as read (moves your watermark) |
| DELETE | `/devices/:id`          (auth)| Delete a device — **owner only**, cascades events + memberships |
| GET    | `/devices/:id/members`  (auth)| Who has access, and in what role    |
| DELETE | `/devices/:id/members/:userId` (auth) | Remove someone (owner) or leave (yourself) |
| GET    | `/devices/:deviceId/events` (auth) | Events, newest first. `?limit=` (max 100) and `?before=<cursor>` |
| POST   | `/devices/:deviceId/events` (auth) | Log an event: `{ type: "motion" \| "ring", meta }` |
| POST   | `/devices/:id/pairing-code` (auth) | **Owner only.** Mint a one-time pairing code for real hardware |
| POST   | `/provision`                  | `{ pairingCode, deviceId }` → a device credential. **No auth** |
| GET    | `/devices/:deviceId/self` (device) | What the Pi can see about itself. Device credential, not a JWT |

Routes marked **(device)** authenticate with a *device credential*
(`Authorization: Bearer pl_porch-1_…`), not a user JWT. The two are separate
principals and neither is accepted where the other is expected.

### Sharing model

Access lives in a `Membership` collection — `{ device, user, role }` — rather
than an `owner` field on the device. That's what lets one household share a
doorbell and one account hold several. A compound unique index on
`{ device, user }` makes joining idempotent: a double-tapped button can't
grant two memberships.

- **owner** — created the device. Can rename, delete, and manage access.
  Sees the `shareCode`.
- **member** — joined with a share code. Can view and change settings.
  Cannot delete the device, remove other people, or see the share code.

The owner cannot leave a device (there'd be nobody left to manage it) — they
delete it instead. Transferring ownership isn't built yet.

Share codes look like `PORCH-7K2M9P`, generated with `crypto.randomInt` over
an alphabet that omits `0/O` and `1/I/L`, since these get read aloud. Input is
normalized, so `porch 7k2m9p` and `7K2M9P` both work.

## Hardware identity and pairing

A `Device` document exists from the moment a user taps "add doorbell", with no
hardware behind it. Pairing is what binds a real Raspberry Pi to one.

**Three secrets, three jobs.** They are easy to confuse and do not substitute
for each other:

| | grants | to whom | lifetime |
|---|---|---|---|
| **share code** `PORCH-7K2M9P` | access to a doorbell | another *person* | until revoked |
| **pairing code** `PAIR-7K2M9P4Q` | the right to become this doorbell | one Pi, once | 10 minutes |
| **credential** `pl_porch-1_…` | "I am porch-1", on every request | that Pi | until re-paired |

**The flow**, three steps with three different principals:

1. `POST /devices/:id/pairing-code` — owner only, returns the code **once**.
2. `POST /provision` — the Pi redeems it for a credential, returned **once**.
   The only unauthenticated endpoint in the app, and it has to be: a
   factory-fresh Pi holds nothing. The code stands in for auth — single use,
   ten-minute expiry, ~850 billion possibilities.
3. `GET /devices/:deviceId/self` — proves the credential works.

**Secrets are stored hashed and shown once.** Only hashes are persisted, and
the schema's `toJSON` strips them on every path out, the same way `User`
strips `passwordHash`. A lost credential is **re-paired, never looked up** —
which is also how you revoke a Pi that walked off, since re-pairing
invalidates the previous credential the instant it saves.

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

**`paired` is not `connected`.** Paired means a Pi has claimed this doorbell
and holds a credential. Connected means one is on the other end of a socket
right now — which only the signaling layer can answer, so `connected` stays
untouched here. `lastContactAt` is the honest thing this layer can say, and
it's written at most once a minute per device rather than on every request.

**`req.hardware`, not `req.device`.** `requireDeviceAccess` already puts a
device on `req.device`, meaning "one this *user* may touch". The two
middlewares authorize against different principals, and a handler reading the
wrong one would be checking the wrong thing entirely.

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
delivery log. `createEvent` responds `201` *before* dispatching — recording
that motion happened is the job that matters, and telling people is
best-effort on top. That call site is where a job queue slots in at real
volume, without callers changing.

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
cursor encodes `createdAt` *and* `_id`, because a motion detector firing
several frames in one second produces events sharing a timestamp, and
`createdAt` alone would skip or repeat them.

## Where this connects to the embedded (C/V4L2) side of the project

`POST /devices/:deviceId/events` is the endpoint the Raspberry Pi's
`v4l2_motion_detect.c` program could eventually call once it detects
motion on real hardware - e.g. via `libcurl` or a lightweight HTTP
client, sending `{ "type": "motion", "meta": { "pixelsChanged": 2240 } }`.
That's a deliberate seam: the frame-differencing logic on the device
stays simple C/V4L2 code, and "what happens with a detected event"
(storing it, notifying a user, showing it in the app) is entirely the
backend's job.

That gap is now half closed. Devices **do** have their own credentials and
their own middleware (`middleware/deviceAuth.js`) — see "Hardware identity and
pairing" above. What has not moved yet is this endpoint: `POST
/devices/:deviceId/events` still requires a *user's* JWT.

It stays that way deliberately until the event schema changes, because the
real device path is not an HTTP POST at all. `docs/server-brief.md` in the
device repo specifies alerts arriving on a signaling WebSocket, carrying a
device-supplied `eventId`, a sensor-fire `at` distinct from receipt time, and
dedupe on `(eventId, kind)` with `motion` → `ring` as an upgrade. That needs a
schema migration and a single shared ingest path used by both transports — two
implementations of the upgrade rule is how a ring silently becomes a motion.
Its own commit, with its own script alongside `scripts/`.

## Project structure

```
server.js                    - entry point: connect, build indexes, start Express
src/
  app.js                     - Express app: middleware, routes, error handler
  config/db.js               - Mongoose connection + ensureIndexes
  models/                    - User, Device, Event, Membership, ... schemas
  middleware/auth.js         - JWT verification (requireAuth)      -> a user
  middleware/deviceAuth.js   - device credentials (requireDevice)  -> a Pi
  middleware/deviceAccess.js - "may this user touch this device?"
  controllers/               - request handlers, one file per resource
  routes/                    - route tables, wired to controllers
  utils/shareCode.js         - person-to-person access codes
  utils/deviceCredential.js  - pairing codes and device credentials
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
- **Index builds run one model at a time, each retried.** Against this cluster
  a single failed handshake clears the whole connection pool, failing every
  operation in flight - so a `Promise.all` over six models turns one unlucky
  handshake into six failures, and retrying the batch re-rolls all six
  together. Five consecutive attempts failed that way before it was
  serialised. Sequentially a failure costs one model one retry. They are
  no-ops once the indexes exist, so it costs nothing worth measuring.
