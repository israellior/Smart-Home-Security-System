import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useDevices } from '../context/DevicesContext';
import { useDevice } from '../components/DeviceLayout';
import { api } from '../api/client';
import styles from './Activity.module.css';

// Stand-in data shown only when the real device has no events yet, so
// a brand-new doorbell isn't just a blank page - it's an honestly
// labeled preview of what real motion/ring events will look like.
const PREVIEW_EVENTS = [
  { id: 'p1', title: 'Motion detected', time: '2:14 PM' },
  { id: 'p2', title: 'Someone rang the bell', time: '11:02 AM' },
  { id: 'p3', title: 'Motion detected', time: 'Yesterday, 6:47 PM' }
];

const EVENT_TITLES = {
  motion: 'Motion detected',
  ring: 'Someone rang the bell'
};

// A row shows when the sensor fired, so an alert the doorbell queued
// through an outage appears at the time it happened - correct, but it
// would otherwise look like we simply knew about it all along. Past this
// gap between firing and arriving, the row says so.
//
// A minute of slack, because ordinary delivery is seconds and a clock
// that drifts slightly shouldn't label every event delayed.
const DELAYED_AFTER_MS = 60 * 1000;

const wasDelayed = (event) =>
  event.at && event.receivedAt && new Date(event.receivedAt) - new Date(event.at) > DELAYED_AFTER_MS;

export function Activity() {
  const { token } = useAuth();
  const { markSeen } = useDevices();
  const device = useDevice();
  const deviceId = device._id;

  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Frozen on open, deliberately. Opening this page marks everything as
  // seen, so reading the live watermark would make the "New" heading
  // disappear from under you the moment it rendered. This keeps the split
  // showing what was new when you arrived; next visit it's cleared.
  const [seenAtOnOpen] = useState(() => device.lastSeenAt);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      try {
        const { events } = await api.listEvents(token, deviceId);
        if (!cancelled) setEvents(events);
      } catch (err) {
        // Say so rather than showing the "Nothing here yet" empty state -
        // we don't actually know that it's empty.
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
    // DeviceLayout resolves the device before this page renders, so
    // deviceId is always a real id here - no waiting-for-a-prerequisite
    // state to model, which is what used to strand this page on "Loading".
  }, [token, deviceId]);

  // Opening the activity list is what "seeing" the events means, so the
  // watermark moves on arrival rather than waiting for the fetch - the
  // split above already captured what was new. Safe to run twice under
  // StrictMode: setting lastSeenAt to now is idempotent.
  useEffect(() => {
    markSeen(deviceId);
  }, [deviceId, markSeen]);

  const hasRealEvents = events.length > 0;

  // Split against the frozen watermark, comparing arrival time rather
  // than sensor time. An alert the doorbell held through an outage
  // carries an old `at` but only reached the server just now - judging it
  // by `at` would file it as already-seen and hide it under "Earlier",
  // which is precisely the event you most wanted to be told about.
  const isNew = (event) => !seenAtOnOpen || new Date(event.receivedAt) > new Date(seenAtOnOpen);
  const newEvents = events.filter(isNew);
  const earlierEvents = events.filter((event) => !isNew(event));

  const renderRow = (event, markNew) => (
    <div className={`${styles.eventRow} ${markNew ? styles.isNew : ''}`} key={event._id}>
      <span className={styles.eventTitle}>
        {EVENT_TITLES[event.type] || event.type}
        {wasDelayed(event) && (
          <span className={styles.delayedTag} title="The doorbell couldn't reach us at the time">
            delayed
          </span>
        )}
      </span>
      {/* Sensor time, not arrival time: this says when someone was at the
          door, which is the question the list is actually answering. */}
      <span className={styles.eventTime}>{new Date(event.at).toLocaleString()}</span>
    </div>
  );

  return (
    <section>
      {loading && (
        <>
          <p className={styles.sectionLabel}>Recent activity</p>
          <p className={styles.loading}>Loading…</p>
        </>
      )}

      {!loading && error && (
        <>
          <p className={styles.sectionLabel}>Recent activity</p>
          <p className={styles.error}>{error}</p>
        </>
      )}

      {!loading && !error && hasRealEvents && (
        <>
          {newEvents.length > 0 && (
            <>
              <p className={styles.sectionLabel}>
                New
                <span className={styles.newCount}>{newEvents.length}</span>
              </p>
              <div>{newEvents.map((event) => renderRow(event, true))}</div>
            </>
          )}

          {earlierEvents.length > 0 && (
            <>
              <p className={styles.sectionLabel}>
                {newEvents.length > 0 ? 'Earlier' : 'Recent activity'}
              </p>
              <div>{earlierEvents.map((event) => renderRow(event, false))}</div>
            </>
          )}
        </>
      )}

      {!loading && !error && !hasRealEvents && (
        <>
          <p className={styles.sectionLabel}>Recent activity</p>
          <div className={styles.empty}>
            <p>Nothing here yet</p>
            <p>
              Motion, rings, and visits will show up here once your doorbell is connected and
              watching.
            </p>
          </div>

          <p className={styles.sectionLabel}>
            What this will look like
            <span className={styles.previewTag}>Preview</span>
          </p>
          {PREVIEW_EVENTS.map((event) => (
            <div className={`${styles.eventRow} ${styles.preview}`} key={event.id}>
              <span className={styles.eventTitle}>{event.title}</span>
              <span className={styles.eventTime}>{event.time}</span>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
