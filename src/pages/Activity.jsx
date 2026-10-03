import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useDevices } from '../context/DevicesContext';
import { useDevice, useDeviceLive } from '../components/DeviceLayout';
import { NewBadge } from '../components/NewBadge';
import { BellIcon, CloseIcon, MotionIcon, PlayIcon } from '../components/Icons';
import { api } from '../api/client';
import styles from './Activity.module.css';

// Stand-in data shown only when the real device has no events yet, so
// a brand-new doorbell isn't just a blank page - it's an honestly
// labeled preview of what real motion/ring events will look like.
//
// One of each clip state among them, so the preview also shows what a
// recording, and the lack of one, will look like.
const PREVIEW_EVENTS = [
  { id: 'p1', type: 'motion', when: '2:14 PM', clip: { durationMs: 15000 } },
  { id: 'p2', type: 'ring', when: '11:02 AM', clip: { durationMs: 15000 } },
  { id: 'p3', type: 'motion', when: 'Yesterday, 6:47 PM', clip: null }
];

const EVENT_TITLES = {
  motion: 'Motion detected',
  ring: 'Someone rang the bell'
};

const EVENT_ICONS = {
  motion: MotionIcon,
  ring: BellIcon
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

/*
 * How long an alert without a clip is shown as having one on the way.
 *
 * An alert never promises a clip. The doorbell records fifteen seconds
 * and then uploads, but it drops anything under two seconds, records
 * nothing while a live view has the camera, and can simply fail - so
 * "no clip yet" has to turn into "no clip" at some point, and nothing
 * tells us when. This is that point: the recording, the upload of a few
 * megabytes over a home uplink, and a generous margin.
 *
 * Measured from `receivedAt` rather than `at`, because a doorbell coming
 * back from an outage sends its old alerts and their clips together - an
 * alert from this morning that arrived a minute ago still has its clip
 * coming.
 */
const CLIP_WAIT_MS = 2 * 60 * 1000;

function clipState(event, now) {
  if (event.clip) return 'ready';
  return now - new Date(event.receivedAt).getTime() < CLIP_WAIT_MS ? 'waiting' : 'none';
}

const pad = (n) => String(n).padStart(2, '0');

function formatDuration(ms) {
  if (!ms) return null;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * When it happened, the way a person says it: "Just now", "4 min ago",
 * then the clock time, then the day. Relative only for the first hour,
 * because "9 hours ago" makes you do arithmetic to learn it was this
 * morning.
 */
function formatWhen(at, now) {
  const then = new Date(at);
  const ago = now - then.getTime();
  if (ago < 60 * 1000) return 'Just now';
  if (ago < 60 * 60 * 1000) return `${Math.floor(ago / 60000)} min ago`;

  const time = then.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(then)) / DAY_MS);
  if (days === 0) return time;
  if (days === 1) return `Yesterday, ${time}`;
  if (days < 7) return `${then.toLocaleDateString([], { weekday: 'long' })}, ${time}`;
  return `${then.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

// Keeps the relative times honest while the page sits open. Half a
// minute, so "Just now" never lingers long past being true.
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return [now, setNow];
}

/**
 * The tile at the head of each row, and the one place that shows which of
 * the three things is true of this alert's recording: there is one, one
 * is on its way, or there is none and will not be.
 */
function ClipThumb({ state, type, clip, open = false, loading = false }) {
  const KindIcon = EVENT_ICONS[type] || MotionIcon;

  if (state === 'waiting') {
    return (
      <span className={`${styles.thumb} ${styles.thumbWaiting}`}>
        <span className={styles.thumbSpinner} aria-hidden="true" />
        <span className={styles.thumbCaption}>Saving</span>
      </span>
    );
  }

  if (state === 'none') {
    return (
      <span className={`${styles.thumb} ${styles.thumbNone}`}>
        <KindIcon size={22} />
      </span>
    );
  }

  const duration = formatDuration(clip?.durationMs);
  return (
    <span className={`${styles.thumb} ${styles.thumbReady} ${open ? styles.thumbOpen : ''}`}>
      <span className={styles.playDisc}>
        {loading ? (
          <span className={styles.discSpinner} aria-hidden="true" />
        ) : open ? (
          <CloseIcon size={14} strokeWidth={2.2} />
        ) : (
          <PlayIcon size={14} />
        )}
      </span>
      {duration && !open && <span className={styles.duration}>{duration}</span>}
    </span>
  );
}

/**
 * Folds one live event into the list.
 *
 * Replaces by _id rather than prepending, because an event can arrive
 * twice: a motion upgraded to a ring is the *same* row with a different
 * kind, and prepending would show one doorbell press as two.
 *
 * Re-sorted by `at` rather than pushed to the top, because a doorbell
 * coming back from an outage sends real events with old timestamps -
 * those belong where they happened, which is also where the ordering the
 * server pages by will put them on the next load.
 */
function mergeEvent(list, incoming) {
  const existing = list.find((e) => e._id === incoming._id);
  const next = list.filter((e) => e._id !== incoming._id);
  // The pushed event carries no clip - clips are joined on when the list
  // is read, not stored on the event - so a ring upgrading a motion that
  // already had its recording would otherwise lose its play button until
  // the next reload.
  next.push(existing?.clip && !incoming.clip ? { ...incoming, clip: existing.clip } : incoming);
  next.sort((a, b) => new Date(b.at) - new Date(a.at) || (a._id < b._id ? 1 : -1));
  return next;
}

export function Activity() {
  const { token } = useAuth();
  const { markSeen, beginReading } = useDevices();
  const device = useDevice();
  const { lastEvent, lastClip } = useDeviceLive();
  const deviceId = device._id;
  const [now, setNow] = useNow();

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

  // And it keeps meaning that for as long as the page is open. Without
  // this, a press that arrives while you are reading the list lands in
  // front of you and *also* raises a badge on the tab you are already on,
  // and still counts as unread on the doorbell list afterwards. Saying so
  // here rather than acting on it is deliberate: DevicesContext owns what
  // happens next, so the badge and the watermark cannot disagree.
  useEffect(() => beginReading(deviceId), [beginReading, deviceId]);

  // A doorbell press while this page is open appears without a refresh.
  // The frozen watermark above means it lands under "New", which is the
  // point - someone is at the door right now.
  useEffect(() => {
    // The device check is belt-and-braces against a frame arriving while
    // the socket is being torn down mid-navigation: merging another
    // doorbell's press into this list would be worse than dropping it.
    if (!lastEvent || lastEvent.device !== deviceId) return;
    setEvents((current) => mergeEvent(current, lastEvent));
  }, [lastEvent, deviceId]);

  // A recording finishing turns "Saving" into a play button in place. No
  // device check needed: the socket is per doorbell and is reset when the
  // doorbell changes, and eventIds only match within one doorbell's list.
  useEffect(() => {
    if (!lastClip) return;
    setEvents((current) =>
      current.map((e) => (e.eventId === lastClip.eventId ? { ...e, clip: lastClip.clip } : e))
    );
  }, [lastClip]);

  /*
   * One quiet re-read when the earliest "Saving" runs out of time.
   *
   * The push above is how a clip normally arrives, but it can be missed -
   * the socket was reconnecting, the laptop was asleep - and a missed push
   * would turn a clip that did arrive into "No clip". Asking once, at the
   * moment the page is about to say that, costs one request per waiting
   * alert rather than a poll, and nothing at all when nothing is waiting.
   */
  const reload = useCallback(async () => {
    try {
      const { events: fresh } = await api.listEvents(token, deviceId);
      setEvents(fresh);
    } catch {
      // The list on screen is still right in every other respect, and the
      // next visit reads it fresh anyway.
    }
  }, [token, deviceId]);

  const nextExpiry = events.reduce((soonest, event) => {
    if (event.clip) return soonest;
    const expires = new Date(event.receivedAt).getTime() + CLIP_WAIT_MS;
    return expires > now && expires < soonest ? expires : soonest;
  }, Infinity);

  useEffect(() => {
    if (nextExpiry === Infinity) return undefined;
    const timer = setTimeout(() => {
      setNow(Date.now());
      reload();
    }, nextExpiry - Date.now() + 250);
    return () => clearTimeout(timer);
  }, [nextExpiry, reload, setNow]);

  // One open clip at a time, tracked by eventId. A signed URL is fetched
  // on press rather than with the list, because it expires - a list left
  // open for twenty minutes would otherwise hold a page of dead URLs.
  const [clip, setClip] = useState({ eventId: null, url: null, loading: false, error: null });

  const openClip = async (eventId) => {
    // Pressing the open clip closes it.
    if (clip.eventId === eventId && (clip.url || clip.error)) {
      setClip({ eventId: null, url: null, loading: false, error: null });
      return;
    }
    setClip({ eventId, url: null, loading: true, error: null });
    try {
      const { url } = await api.getClipUrl(token, deviceId, eventId);
      setClip({ eventId, url, loading: false, error: null });
    } catch (err) {
      setClip({ eventId, url: null, loading: false, error: err.message });
    }
  };

  const hasRealEvents = events.length > 0;

  // Split against the frozen watermark, comparing arrival time rather
  // than sensor time. An alert the doorbell held through an outage
  // carries an old `at` but only reached the server just now - judging it
  // by `at` would file it as already-seen and hide it under "Earlier",
  // which is precisely the event you most wanted to be told about.
  const isNew = (event) => !seenAtOnOpen || new Date(event.receivedAt) > new Date(seenAtOnOpen);
  const newEvents = events.filter(isNew);
  const earlierEvents = events.filter((event) => !isNew(event));

  const renderRow = (event, markNew) => {
    const state = clipState(event, now);
    const isOpen = clip.eventId === event.eventId && Boolean(clip.url || clip.error);
    const isLoading = clip.eventId === event.eventId && clip.loading;
    const KindIcon = EVENT_ICONS[event.type] || MotionIcon;
    const title = EVENT_TITLES[event.type] || event.type;
    const when = formatWhen(event.at, now);

    let caption = 'No clip';
    let captionHint =
      'Nothing was recorded for this one - it was very short, or the camera was busy with a live view.';
    if (state === 'ready') {
      caption = event.clip.partial ? 'Clip · cut short' : 'Clip';
      captionHint = event.clip.partial
        ? 'Someone opened the live view and cut the recording short'
        : undefined;
    } else if (state === 'waiting') {
      caption = 'Saving clip…';
      captionHint = undefined;
    }

    const content = (
      <>
        <ClipThumb
          state={state}
          type={event.type}
          clip={event.clip}
          open={isOpen}
          loading={isLoading}
        />
        <span className={styles.body}>
          <span className={styles.eventTitle}>
            <KindIcon size={15} />
            <span className={styles.titleText}>{title}</span>
            {wasDelayed(event) && (
              <span
                className={styles.delayedTag}
                title="The doorbell couldn't reach us at the time"
              >
                delayed
              </span>
            )}
          </span>
          {/* Sensor time, not arrival time: this says when someone was at
              the door, which is the question the list is actually
              answering. */}
          <span className={styles.meta}>
            <time dateTime={event.at} title={new Date(event.at).toLocaleString()}>
              {when}
            </time>
            <span aria-hidden="true"> · </span>
            <span className={state === 'waiting' ? styles.metaWaiting : undefined} title={captionHint}>
              {caption}
            </span>
          </span>
        </span>
      </>
    );

    const rowClass = `${styles.eventRow} ${markNew ? styles.isNew : ''} ${
      isOpen ? styles.rowOpen : ''
    }`;

    return (
      <li className={styles.eventGroup} key={event._id}>
        {/* The whole row is the play button when there is something to
            play - the tile alone is a small target on a phone, and a row
            that looks tappable and isn't is worse. */}
        {state === 'ready' ? (
          <button
            type="button"
            className={`${rowClass} ${styles.rowButton}`}
            onClick={() => openClip(event.eventId)}
            disabled={isLoading}
            aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Close' : 'Play'} clip: ${title}, ${when}`}
          >
            {content}
          </button>
        ) : (
          <div className={rowClass}>{content}</div>
        )}

        {clip.eventId === event.eventId && clip.url && (
          // controls + autoPlay, because pressing the row is already the
          // decision to play - making them press again would be a second
          // tap for nothing.
          <div className={styles.playerWrap}>
            <video className={styles.player} src={clip.url} controls autoPlay playsInline />
          </div>
        )}
        {clip.eventId === event.eventId && clip.error && (
          <p className={styles.clipError}>{clip.error}</p>
        )}
      </li>
    );
  };

  return (
    <section>
      {loading && (
        <>
          <p className={styles.sectionLabel}>Recent activity</p>
          {/* The shape of the list rather than the word "Loading": the page
              does not jump when the rows arrive, and it looks like what it
              is about to be. */}
          <ul className={styles.list} aria-busy="true" aria-label="Loading activity">
            {[0, 1, 2].map((i) => (
              <li className={`${styles.eventRow} ${styles.skeleton}`} key={i}>
                <span className={`${styles.thumb} ${styles.skeletonBlock}`} />
                <span className={styles.body}>
                  <span className={`${styles.skeletonLine} ${styles.skeletonBlock}`} />
                  <span
                    className={`${styles.skeletonLine} ${styles.skeletonShort} ${styles.skeletonBlock}`}
                  />
                </span>
              </li>
            ))}
          </ul>
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
                <NewBadge count={newEvents.length} />
              </p>
              <ul className={styles.list}>{newEvents.map((event) => renderRow(event, true))}</ul>
            </>
          )}

          {earlierEvents.length > 0 && (
            <>
              <p className={styles.sectionLabel}>
                {newEvents.length > 0 ? 'Earlier' : 'Recent activity'}
              </p>
              <ul className={styles.list}>
                {earlierEvents.map((event) => renderRow(event, false))}
              </ul>
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
          <ul className={styles.list} aria-hidden="true">
            {PREVIEW_EVENTS.map((event) => {
              const KindIcon = EVENT_ICONS[event.type];
              return (
                <li className={`${styles.eventRow} ${styles.preview}`} key={event.id}>
                  <ClipThumb state={event.clip ? 'ready' : 'none'} type={event.type} clip={event.clip} />
                  <span className={styles.body}>
                    <span className={styles.eventTitle}>
                      <KindIcon size={15} />
                      <span className={styles.titleText}>{EVENT_TITLES[event.type]}</span>
                    </span>
                    <span className={styles.meta}>
                      {event.when} · {event.clip ? 'Clip' : 'No clip'}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
