import 'dotenv/config';
import { createApp } from './src/app.js';
import { connectDB } from './src/config/db.js';

const PORT = process.env.PORT || 4000;

async function main() {
  await connectDB();
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`Porchlight API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
