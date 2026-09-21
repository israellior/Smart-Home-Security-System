import 'dotenv/config';
import { createApp } from './src/app.js';
import { connectDB, ensureIndexes } from './src/config/db.js';

const PORT = process.env.PORT || 4000;

async function main() {
  await connectDB();
  // Before the port opens, not after. Every unique index in this app
  // enforces a rule that has no other enforcement, so serving traffic
  // without them is serving traffic with those rules switched off.
  await ensureIndexes();
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`Porchlight API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
