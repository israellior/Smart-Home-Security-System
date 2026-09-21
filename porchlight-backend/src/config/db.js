import mongoose from 'mongoose';

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 1500;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry wrapper for the startup steps that talk to Atlas.
 *
 * This cluster's TLS handshake fails intermittently - a server-side
 * alert, not credentials and not the IP allowlist - and the failure is
 * not confined to the first connect. A handshake failing a moment later
 * clears the driver's connection pool, so the *next* operation fails too
 * even though `connect` already succeeded. Any step that must complete
 * before the port opens therefore needs its own retry, not just the
 * connect.
 */
async function withRetry(label, run) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await run();
    } catch (err) {
      lastError = err;
      const summary = err.message.split('\n')[0].slice(0, 100);
      console.warn(`${label} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${summary}`);
      if (attempt < MAX_ATTEMPTS) await wait(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

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
  await withRetry('MongoDB connect', () => mongoose.connect(uri));
}

/**
 * Blocks until every registered model's indexes actually exist.
 *
 * Mongoose does build indexes on its own, but it does it in the
 * background when the model is compiled, and it tells nobody how it
 * went: the build is fire-and-forget, and a failure is emitted on an
 * 'index' event that nothing listens to. So a freshly started process
 * serves requests during the window before its unique indexes exist.
 *
 * That window is not academic. A unique index here is not tidiness, it
 * is the only thing enforcing a rule - one doorbell per deviceId, one
 * membership per (device, user), one share code in the world. During the
 * gap those rules simply do not hold, and the damage outlives it: two
 * devices provisioned under one deviceId stay that way, and afterwards
 * the index can never finish building.
 *
 * This is exactly the shape of bug the device-side notes warn about -
 * every check passes, because the missing guarantee is invisible until
 * something concurrent hits it. Found by two doorbells successfully
 * claiming the same deviceId in an end-to-end run.
 *
 * Model.init() resolves when that model's build is done and rejects if
 * it failed, so awaiting all of them turns a silent race into a startup
 * step that either succeeds or refuses to boot. Models register
 * themselves when their modules are imported, which ESM does before
 * main() runs, so by the time this is called the list is complete.
 */
export async function ensureIndexes() {
  const names = Object.keys(mongoose.models);

  // One model at a time, each with its own retry, rather than one
  // Promise.all over all six.
  //
  // Parallelism is actively harmful against this cluster. A single failed
  // handshake clears the whole connection pool, which fails every
  // operation currently in flight - so six concurrent builds turn one
  // unlucky handshake into six failures, and Promise.all then rejects the
  // batch. Retrying the batch re-rolls all six dice together, which is
  // why five attempts in a row could all fail.
  //
  // Sequentially, a failure costs one model one retry and cannot touch
  // the others. These are six no-op calls once the indexes exist, so
  // serialising them costs nothing worth measuring at startup.
  for (const name of names) {
    // createIndexes(), not init(): init() memoises its promise, including
    // a rejected one, so retrying it would replay the same failure
    // forever instead of actually trying again.
    await withRetry(`Index build (${name})`, () => mongoose.models[name].createIndexes());
  }

  console.log(`Indexes ready (${names.length} models: ${names.join(', ')})`);
}
