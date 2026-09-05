import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
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

export function Activity() {
  const { token } = useAuth();
  const device = useDevice();
  const deviceId = device._id;

  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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

  const hasRealEvents = events.length > 0;

  return (
    <section>
      <p className={styles.sectionLabel}>Recent activity</p>

      {loading && <p className={styles.loading}>Loading…</p>}

      {!loading && error && <p className={styles.error}>{error}</p>}

      {!loading && !error && hasRealEvents && (
        <div>
          {events.map((event) => (
            <div className={styles.eventRow} key={event._id}>
              <span className={styles.eventTitle}>{EVENT_TITLES[event.type] || event.type}</span>
              <span className={styles.eventTime}>{new Date(event.createdAt).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      {!loading && !error && !hasRealEvents && (
        <>
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
