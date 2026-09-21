import express from 'express';
import cors from 'cors';
// Express 4 does NOT automatically catch rejected promises thrown inside
// async route handlers - without this, an error in an `await`ed call
// (e.g. a bad Mongo query) would crash the process instead of reaching
// the error handler below. This patches Express to forward those errors
// via next(err) automatically, so every controller can stay a plain
// async function with no try/catch boilerplate.
import 'express-async-errors';
import { authRoutes } from './routes/authRoutes.js';
import { deviceRoutes } from './routes/deviceRoutes.js';
import { hardwareRoutes } from './routes/hardwareRoutes.js';

export function createApp() {
  const app = express();

  app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
  app.use(express.json());

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.use('/api/auth', authRoutes);

  // Hardware first. deviceRoutes applies requireAuth to everything it
  // holds, so anything reaching it must carry a *user* token - a Pi
  // presenting a device credential there would be rejected before its
  // handler ever ran. Mounting hardwareRoutes ahead of it lets the
  // device-authenticated paths match first; everything else falls
  // through untouched.
  //
  // Every route below authenticates. There is no enrolment endpoint,
  // because devices are provisioned offline rather than over the wire.
  app.use('/api/devices', hardwareRoutes);
  app.use('/api/devices', deviceRoutes);

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Central error handler. express-async-errors (imported above) makes
  // sure every async controller's thrown/rejected errors end up here
  // instead of crashing the process.
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server' });
  });

  return app;
}
