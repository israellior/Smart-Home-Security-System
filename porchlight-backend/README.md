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

One real-world gap worth being upfront about: this endpoint currently
requires a *user's* JWT, which a standalone device obviously doesn't
have. A production version would give each device its own long-lived
API key (a separate field on the `Device` model, checked with its own
lightweight middleware) rather than reusing user auth - that's a
natural "next thing to build" if you want to extend this further.

## Project structure

```
server.js                    - entry point: connect to Mongo, start Express
src/
  app.js                     - Express app: middleware, routes, error handler
  config/db.js               - Mongoose connection
  models/                    - User, Device, Event schemas
  middleware/auth.js         - JWT verification (requireAuth)
  controllers/               - request handlers, one file per resource
  routes/                    - route tables, wired to controllers
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
