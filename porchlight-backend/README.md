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
| GET    | `/devices`              (auth)| List your device(s)                 |
| POST   | `/devices`              (auth)| Create a device                     |
| PATCH  | `/devices/:id`          (auth)| Update name/location/sensitivity/notifications |
| GET    | `/devices/:deviceId/events` (auth) | Last 50 events for a device    |
| POST   | `/devices/:deviceId/events` (auth) | Log an event: `{ type: "motion" \| "ring", meta }` |

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
  paranoia).
