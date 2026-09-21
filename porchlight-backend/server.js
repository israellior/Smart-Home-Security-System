import 'dotenv/config';
import { createServer } from 'node:http';
import { createApp } from './src/app.js';
import { connectDB, ensureIndexes } from './src/config/db.js';
import { attachSignaling, resetPresence } from './src/signaling/index.js';

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
  attachSignaling(server);

  server.listen(PORT, () => {
    console.log(`Porchlight API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
