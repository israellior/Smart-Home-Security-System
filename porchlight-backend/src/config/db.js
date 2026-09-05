import mongoose from 'mongoose';

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 1500;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set - copy .env.example to .env and fill it in.');
  }

  mongoose.connection.on('connected', () => {
    console.log('MongoDB connected');
  });
  mongoose.connection.on('error', (err) => {
    console.error('MongoDB connection error:', err.message);
  });

  // Retried because the initial handshake to this Atlas cluster fails
  // intermittently (a TLS alert from the server, not a credentials or
  // allowlist problem). Without this the process exits on the first
  // failure, so starting the API becomes a coin flip. Once a connection
  // is established the driver's own pool handles later drops; this only
  // covers getting off the ground.
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await mongoose.connect(uri);
      return;
    } catch (err) {
      lastError = err;
      const summary = err.message.split('\n')[0].slice(0, 100);
      console.warn(`MongoDB connect attempt ${attempt}/${MAX_ATTEMPTS} failed: ${summary}`);
      if (attempt < MAX_ATTEMPTS) await wait(RETRY_DELAY_MS);
    }
  }

  throw lastError;
}
