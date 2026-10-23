import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDevices } from '../context/DevicesContext';
import { useDevice, useDeviceLive } from '../components/DeviceLayout';
import { NewBadge } from '../components/NewBadge';
import {
  BellIcon,
  BookmarkIcon,
  CloseIcon,
  MotionIcon,
  PlayIcon,
  RecordIcon
} from '../components/Icons';
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
  ring: 'Someone rang the bell',
  live: 'Recorded from live view'
};

// When the doorbell recognised who it was, the server names them as
// `visitor`. Only ever a better title: a known face is still a motion or a
// ring, and still sits under the same filter.
const VISITOR_TITLES = {
  motion: (name) => `${name} at the door`,
  ring: (name) => `${name} rang the bell`
};

function titleOf(event) {
  const named = event.visitor && VISITOR_TITLES[event.type];
  return named ? named(event.visitor) : EVENT_TITLES[event.type] || event.type;
}

const EVENT_ICONS = {
  motion: MotionIcon,
  ring: BellIcon,
  live: RecordIcon
};

/*
 * The ways to narrow the list. Kinds first, in the order they matter at a
 * door - somebody rang, something moved, somebody kept a moment - and Saved
 * last, because it is the one that reaches back further than the week.
 *
 * Each asks the server rather than filtering what is already loaded: a page
 * is fifty rows, and fifty motion alerts would leave "Rings" empty while
 * there were rings on the next page.
 */
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'ring', label: 'Rings' },
  { value: 'motion', label: 'Motion' },
  { value: 'live', label: 'Recorded' },
  // The one with an icon, because it is the one that is not a kind: every
  // row already wears its kind's icon, and the bookmark is the mark a
  // saved row wears.
  { value: 'saved', label: 'Saved', Icon: BookmarkIcon }
];

const FILTER_VALUES = FILTERS.map((f) => f.value);

// What an empty filter says. "This week" because that is all there is to
// look through - except Saved, whose whole point is not being limited to it.
const EMPTY = {
  ring: ['No rings this week', 'When someone presses the button, it shows up here.'],
  motion: ['No motion this week', 'Movement at your door shows up here.'],
  live: [
    'No recordings this week',
    'Press Rec while watching live, and the recording is kept here for everyone on this doorbell.'
  ],
  saved: [
    'Nothing saved yet',
    'Tap the bookmark on any clip to keep it after the week is up. Saved clips stay until someone unsaves them.'
  ]
};

// A recording a member kept, rather than something the doorbell noticed.
// It is never "new": the person who made it was there, and nobody else is
// being told that someone is at the door.
const isRecording = (event) => event.type === 'live';

// Whose it was, from the name the server stored when it was saved - so it
// still reads right after they have left the doorbell.
function recordedBy(event, userId) {
  const by = event.meta?.recordedBy;
  if (!by) return null;
  if (userId && by.id === userId) return 'by you';
  return by.name ? `by ${by.name}` : null;
}

function savedByLabel(event, userId) {
  const by = event.savedBy;
  if (!by) return 'Saved';
  if (userId && by.id === userId) return 'Saved by you';
  return by.name ? `Saved by ${by.name}` : 'Saved';
}

/** Whether a row belongs in the list the filter asked for. */
function matchesFilter(event, filter) {
  if (filter === 'all') return true;
  if (filter === 'saved') return Boolean(event.savedAt);
  return event.type === filter;
}

// Gone from the list the moment it is due, rather than when the server's
// hourly sweep gets to it - the server stops returning it at that moment
// too, so the two agree.
const isExpired = (event, now) => event.expiresAt && new Date(event.expiresAt).getTime() <= now;

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

// Day and month names in the app's own language. Left to the browser they
// came out in the phone's - "Yesterday" over "יום שני" on a Hebrew phone -
// while every word around them is English. Clock times stay the browser's,
// because 24-hour or 12-hour is the reader's habit, not the app's.
const NAMES_LOCALE = 'en-US';
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const daysBetween = (from, to) => Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS);

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
  const days = daysBetween(then, new Date(now));
  if (days === 0) return time;
  if (days === 1) return `Yesterday, ${time}`;
  if (days < 7) return `${then.toLocaleDateString(NAMES_LOCALE, { weekday: 'long' })}, ${time}`;
  return `${then.toLocaleDateString(NAMES_LOCALE, { month: 'short', day: 'numeric' })}, ${time}`;
}

/**
 * The heading over one day's rows. Rows under a day heading say only the
 * time, so this carries the day: "Today", "Yesterday", the weekday for the
 * rest of the week, and a date beyond it - which only saved rows reach.
 */
function dayHeading(day, now) {
  const date = new Date(day);
  const days = daysBetween(date, new Date(now));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString(NAMES_LOCALE, { weekday: 'long' });
  return date.toLocaleDateString(NAMES_LOCALE, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== new Date(now).getFullYear() && { year: 'numeric' })
  });
}

/** Rows grouped by the day they happened on, newest day first. */
function byDay(events) {
  const days = [];
  for (const event of events) {
    const day = startOfDay(new Date(event.at));
    const last = days[days.length - 1];
    if (last && last.day === day) last.events.push(event);
    else days.push({ day, events: [event] });
  }
  return days;
}

/**
 * "Deleted today" or "Deleted tomorrow" on a clip about to go, and nothing
 * before that. Said late on purpose: a countdown on every row would be a
 * week of noise to warn about the last day of it.
 */
function expiryNote(event, now) {
  if (!event.expiresAt) return null;
  const days = daysBetween(new Date(now), new Date(event.expiresAt));
  if (days <= 0) return 'Deleted today';
  if (days === 1) return 'Deleted tomorrow';
  return null;
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
  const merged = existing?.clip && !incoming.clip ? { ...incoming, clip: existing.clip } : incoming;
  // Likewise the visitor's name, should a push have gone out without it -
  // the server's lookup is best-effort.
  next.push(existing?.visitor && !merged.visitor ? { ...merged, visitor: existing.visitor } : merged);
  next.sort((a, b) => new Date(b.at) - new Date(a.at) || (a._id < b._id ? 1 : -1));
  return next;
}

export function Activity() {
  const { token, user } = useAuth();
  const { markSeen, beginReading } = useDevices();
  const device = useDevice();
  const { lastEvent, lastClip, lastSaved } = useDeviceLive();
  const deviceId = device._id;
  const [now, setNow] = useNow();

  // In the URL, so a filter survives a reload and Back undoes it - and so
  // "Saved" is a link someone can be sent to.
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('show');
  const filter = FILTER_VALUES.includes(requested) ? requested : 'all';
  const chooseFilter = (value) =>
    setSearchParams(value === 'all' ? {} : { show: value }, { replace: true });

  const [events, setEvents] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [retentionMs, setRetentionMs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [saveError, setSaveError] = useState(null);

  // Frozen on open, deliberately. Opening this page marks everything as
  // seen, so reading the live watermark would make the "New" heading
  // disappear from under you the moment it rendered. This keeps the split
  // showing what was new when you arrived; next visit it's cleared.
  const [seenAtOnOpen] = useState(() => device.lastSeenAt);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEvents([]);
    setNextCursor(null);

    async function load() {
      try {
        const page = await api.listEvents(token, deviceId, { filter });
        if (cancelled) return;
        setEvents(page.events);
        setNextCursor(page.nextCursor);
        setRetentionMs(page.retentionMs ?? null);
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
  }, [token, deviceId, filter]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.listEvents(token, deviceId, { filter, before: nextCursor });
      setEvents((current) => page.events.reduce(mergeEvent, current));
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingMore(false);
    }
  };

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

  // Folds a pushed or answered event in, and drops it if it no longer
  // belongs under the current filter - a motion that became a ring leaves
  // "Motion"; a row somebody unsaved leaves "Saved".
  const absorb = useCallback(
    (incoming) =>
      setEvents((current) => mergeEvent(current, incoming).filter((e) => matchesFilter(e, filter))),
    [filter]
  );

  // A doorbell press while this page is open appears without a refresh.
  // The frozen watermark above means it lands under "New", which is the
  // point - someone is at the door right now.
  useEffect(() => {
    // The device check is belt-and-braces against a frame arriving while
    // the socket is being torn down mid-navigation: merging another
    // doorbell's press into this list would be worse than dropping it.
    if (!lastEvent || lastEvent.device !== deviceId) return;
    absorb(lastEvent);
  }, [lastEvent, deviceId, absorb]);

  // Somebody else saved or unsaved a row. Same check, same merge.
  useEffect(() => {
    if (!lastSaved || lastSaved.device !== deviceId) return;
    absorb(lastSaved);
  }, [lastSaved, deviceId, absorb]);

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
   *
   * Merged rather than replacing the list, so the pages already loaded
   * below the first stay where they are.
   */
  const reload = useCallback(async () => {
    try {
      const { events: fresh } = await api.listEvents(token, deviceId, { filter });
      setEvents((current) => fresh.reduce(mergeEvent, current));
    } catch {
      // The list on screen is still right in every other respect, and the
      // next visit reads it fresh anyway.
    }
  }, [token, deviceId, filter]);

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

  /*
   * Save, or stop saving. Answered by the server with the row as it now
   * stands, which is merged like any push - so this tab and every other
   * one end up showing the same thing by the same path.
   *
   * Unsaving something older than the week deletes it, clip and all, and
   * that cannot be undone - so that one case asks first. Everything else
   * is a toggle that undoes itself.
   */
  const [savingId, setSavingId] = useState(null);

  const toggleSaved = async (event) => {
    setSaveError(null);
    if (event.savedAt && retentionMs) {
      const wouldExpire = new Date(event.receivedAt).getTime() + retentionMs <= Date.now();
      if (
        wouldExpire &&
        !window.confirm(
          'This clip is more than a week old. Unsaving it deletes it for everyone on this doorbell, and it can’t be brought back.'
        )
      ) {
        return;
      }
    }

    setSavingId(event._id);
    try {
      const { event: updated } = event.savedAt
        ? await api.unsaveEvent(token, deviceId, event.eventId)
        : await api.saveEvent(token, deviceId, event.eventId);
      absorb({ ...updated, clip: updated.clip ?? event.clip });
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSavingId(null);
    }
  };

  const visible = events.filter((event) => !isExpired(event, now));
  const hasRealEvents = visible.length > 0;

  // Split against the frozen watermark, comparing arrival time rather
  // than sensor time. An alert the doorbell held through an outage
  // carries an old `at` but only reached the server just now - judging it
  // by `at` would file it as already-seen and hide it under "Earlier",
  // which is precisely the event you most wanted to be told about.
  const isNew = (event) =>
    !isRecording(event) &&
    (!seenAtOnOpen || new Date(event.receivedAt) > new Date(seenAtOnOpen));
  const newEvents = visible.filter(isNew);
  const earlierEvents = visible.filter((event) => !isNew(event));

  const renderRow = (event, markNew) => {
    const state = clipState(event, now);
    const isOpen = clip.eventId === event.eventId && Boolean(clip.url || clip.error);
    const isLoading = clip.eventId === event.eventId && clip.loading;
    const KindIcon = EVENT_ICONS[event.type] || MotionIcon;
    const title = titleOf(event);
    // Under a day heading the day is already said; the row needs only its
    // time. "New" rows have no day heading, so they keep the full form.
    const when = markNew
      ? formatWhen(event.at, now)
      : new Date(event.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    let caption = 'No clip';
    let captionHint =
      'Nothing was recorded for this one - it was very short, or the camera was busy with a live view.';
    if (state === 'ready' && isRecording(event)) {
      caption = ['Recording', recordedBy(event, user?.id)].filter(Boolean).join(' ');
      captionHint = undefined;
    } else if (state === 'ready') {
      caption = event.clip.partial ? 'Clip · cut short' : 'Clip';
      captionHint = event.clip.partial
        ? 'Someone opened the live view and cut the recording short'
        : undefined;
    } else if (state === 'waiting') {
      caption = 'Saving clip…';
      captionHint = undefined;
    }

    // Who kept it, where that is the question being asked; elsewhere the
    // filled bookmark says it, and its label says who.
    const savedNote = event.savedAt && filter === 'saved' ? savedByLabel(event, user?.id) : null;
    const expiring = state === 'ready' ? expiryNote(event, now) : null;
    // Saving is about keeping a clip. A row without one has nothing to
    // keep - unless it was saved before, in which case it can be unsaved.
    const canSave = state === 'ready' || Boolean(event.savedAt);

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
            {savedNote && (
              <>
                <span aria-hidden="true"> · </span>
                <span>{savedNote}</span>
              </>
            )}
            {expiring && (
              <>
                <span aria-hidden="true"> · </span>
                <span className={styles.metaExpiring}>{expiring}</span>
              </>
            )}
          </span>
        </span>
      </>
    );

    const rowClass = `${styles.eventRow} ${markNew ? styles.isNew : ''} ${
      isOpen ? styles.rowOpen : ''
    }`;

    return (
      <li className={styles.eventGroup} key={event._id}>
        <div className={styles.rowLine}>
          {/* The row is the play button when there is something to play -
              the tile alone is a small target on a phone, and a row that
              looks tappable and isn't is worse. The bookmark sits beside
              it rather than inside: a button within a button is neither. */}
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

          {canSave && (
            <button
              type="button"
              className={`${styles.saveBtn} ${event.savedAt ? styles.saveBtnOn : ''}`}
              onClick={() => toggleSaved(event)}
              disabled={savingId === event._id}
              aria-pressed={Boolean(event.savedAt)}
              aria-label={event.savedAt ? `${savedByLabel(event, user?.id)}. Unsave` : 'Save this clip'}
              title={event.savedAt ? savedByLabel(event, user?.id) : 'Save - keep it after the week'}
            >
              <BookmarkIcon size={19} filled={Boolean(event.savedAt)} />
            </button>
          )}
        </div>

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

  const retentionDays = retentionMs ? Math.round(retentionMs / DAY_MS) : null;

  return (
    <section>
      {/* What to show. Pills rather than a segmented control: five labels
          do not fit a phone's width as equal segments, and pills can
          scroll sideways where segments would have to shrink. */}
      <div className={styles.filters} role="group" aria-label="Show">
        {FILTERS.map(({ value, label, Icon }) => (
          <button
            key={value}
            type="button"
            className={`${styles.filter} ${filter === value ? styles.filterOn : ''}`}
            onClick={() => chooseFilter(value)}
            aria-pressed={filter === value}
          >
            {Icon && <Icon size={13} filled={value === 'saved' && filter === value} />}
            {label}
          </button>
        ))}
      </div>

      {saveError && <p className={styles.error}>{saveError}</p>}

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

          {byDay(earlierEvents).map(({ day, events: dayEvents }) => (
            <div key={day}>
              <p className={styles.sectionLabel}>{dayHeading(day, now)}</p>
              <ul className={styles.list}>{dayEvents.map((event) => renderRow(event, false))}</ul>
            </div>
          ))}

          {nextCursor && (
            <button
              type="button"
              className={styles.moreBtn}
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : 'Show earlier'}
            </button>
          )}
        </>
      )}

      {!loading && !error && !hasRealEvents && filter !== 'all' && (
        <div className={styles.empty}>
          <p>{EMPTY[filter][0]}</p>
          <p>{EMPTY[filter][1]}</p>
        </div>
      )}

      {!loading && !error && !hasRealEvents && filter === 'all' && (
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

      {/* The rule, said once at the foot of the list rather than on every
          row. Not under Saved, where it is the one thing that does not
          apply. */}
      {!loading && !error && retentionDays && filter !== 'saved' && (
        <p className={styles.retention}>
          <BookmarkIcon size={13} />
          Activity keeps the last {retentionDays} days. Save a clip to keep it longer.
        </p>
      )}
    </section>
  );
}
