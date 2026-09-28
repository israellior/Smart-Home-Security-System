import 'dotenv/config';
import { createServer } from 'node:http';
import mongoose from 'mongoose';
import { createApp } from './src/app.js';
import { connectDB, ensureIndexes } from './src/config/db.js';
import { attachSignaling, resetPresence } from './src/signaling/index.js';
import { checkClockSkew } from './src/config/media.js';

const PORT = process.env.PORT || 4000;

async function main() {
  await connectDB();
  // Before the port opens, not after. Every unique index in this app
  // enforces a rule that has no other enforcement, so serving traffic
  // without them is serving traffic with those rules switched off.
  await ensureIndexes();
  // Also before the port opens: whatever the database last recorded,
  // nothing is connected to a process that has only just started.
  await resetPresence();

  const app = createApp();

  // An explicit http server rather than app.listen(), so the WebSocket
  // can share the port. One origin for both means the browser needs no
  // second host and no second CORS story, and the API and the socket
  // cannot drift apart in deployment.
  const server = createServer(app);
  const wss = attachSignaling(server);

  server.listen(PORT, () => {
    console.log(`Porchlight API listening on http://localhost:${PORT}`);
  });

  // Every deploy sends SIGTERM (docker stop), and without a handler Node
  // just dies: every socket drops with 1006, which says "something broke"
  // to a doorbell and to anyone watching. 1012 says "service restart",
  // which is what it is. The bridge retries anything but 4001/4002, so
  // the device comes straight back to the new process either way - this
  // is about the close being honest, and about in-flight HTTP requests
  // finishing instead of being cut off mid-write.
  process.once('SIGTERM', () => shutdown(server, wss, 'SIGTERM'));
  process.once('SIGINT', () => shutdown(server, wss, 'SIGINT'));

  // After listening, and not awaited. Media tokens carry nbf = mint
  // time, so a drifted clock breaks live view in a way that looks like
  // anything but a clock - but finding that out must not delay the API
  // from taking alerts.
  checkClockSkew();
}

// Under Docker's default 10s stop timeout, after which it sends SIGKILL
// and none of this matters. Anything still open by then is a socket that
// did not answer its close frame - the same peer the heartbeat would
// have terminated anyway.
const SHUTDOWN_GRACE_MS = 8000;

function shutdown(server, wss, signal) {
  console.log(`${signal} received - closing connections`);
  setTimeout(() => {
    console.warn('Shutdown grace period over - exiting with connections open');
    process.exit(1);
  }, SHUTDOWN_GRACE_MS).unref();

  // Stops accepting, and fires the callback once every connection -
  // upgraded WebSockets included - has ended. Idle keep-alive sockets
  // are closed by Node itself (19+), so they cannot hold this open.
  server.close(async () => {
    // After the sockets, not before: their close handlers write presence,
    // and those writes need the connection still up. What they miss,
    // resetPresence() on the next start sweeps up.
    await mongoose.disconnect().catch(() => {});
    console.log('Shut down cleanly');
    process.exit(0);
  });

  for (const socket of wss.clients) socket.close(1012, 'Service restart');
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
