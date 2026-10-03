import { EventEmitter } from 'node:events';

/**
 * In-process fan-out for "something happened to an event".
 *
 * ingestEvent emits here; the signaling layer listens and pushes to
 * whoever is watching. The indirection buys one thing worth having:
 * ingest does not import the socket registry, so the rules stay testable
 * without a server and a transport can be added or removed without
 * touching the code that decides what is true.
 *
 * A doorbell has a handful of viewers, so a raised listener cap would
 * hide a leak rather than solve one - left at the default on purpose.
 */
export const eventBus = new EventEmitter();

export const EVENT_INGESTED = 'event:ingested';

// A clip finished uploading and is playable. Separate from EVENT_INGESTED
// because it is not a new event - nobody should be notified, and a viewer
// counting unread alerts must not count it - it only fills in one that is
// already on screen.
export const CLIP_STORED = 'clip:stored';
