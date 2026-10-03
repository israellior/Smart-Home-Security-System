import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

/**
 * Recording the live view, into everyone's Activity.
 *
 * The browser does the recording because nothing else can. While a call is
 * up the doorbell's camera belongs to the call, and the Pi is already
 * software-encoding one H.264 stream - a second, for a recording, is more
 * than it has. This page, meanwhile, holds the decoded picture, the
 * doorbell's sound and our own microphone, so it records those and uploads
 * the finished file straight to the bucket, the way the doorbell uploads
 * its clips. The server only hands out the grant and checks what arrived.
 *
 * Takes the tracks useLiveView exposes and never stops them - they belong
 * to the call, and stopping the picture's track to end a recording would
 * end the picture.
 */

// The server refuses anything longer (MAX_DURATION_MS in
// recordingController.js), so the two must move together.
export const MAX_RECORDING_MS = 5 * 60 * 1000;

// The doorbell sends 640x360, so a megabit is generous for it, and it keeps
// five minutes near 40MB - a size a home uplink sends in reasonable time.
const VIDEO_BITS_PER_SECOND = 1_000_000;
const AUDIO_BITS_PER_SECOND = 64_000;

/*
 * MP4 or nothing.
 *
 * A recording lands in a list every member plays back, on whatever phone
 * they have. Left to choose, Chrome and Firefox write WebM, which older
 * iPhones will not play - so a recording made on an Android would be a
 * dead row for half the household. Safari and current Chrome and Edge all
 * record MP4; Firefox does not, and gets told so instead of a file some
 * people cannot open. It also keeps the bucket to one format, which the
 * object keys and the content type already assume.
 *
 * H.264 with AAC first, the pair every player handles; bare video/mp4 last,
 * which lets the browser pick its codecs.
 */
const MIME_TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4'
];

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

const UNSUPPORTED =
  'This browser can’t record video that every phone can play. Chrome, Edge and Safari can.';

/*
 * Each step is retried a few times before anyone is told it failed. The
 * database behind the confirm drops connections in bursts, and a recording
 * lost to a single bad handshake would be a poor trade for three lines.
 *
 * 4xx is the server's answer and asking again will not change it - except
 * a timeout and a rate limit, which are "not now".
 */
const ATTEMPTS = 3;

function isPermanent(err) {
  return err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

async function retrying(fn) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= ATTEMPTS || isPermanent(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
  }
}

async function put(grant, blob) {
  // Exactly the grant's headers. Content-Type and Content-Length are both
  // in the signature, and the browser sets the length from the blob.
  const res = await fetch(grant.url, { method: grant.method, headers: grant.headers, body: blob });
  if (!res.ok) {
    const err = new Error(`The upload was refused (${res.status})`);
    err.status = res.status;
    throw err;
  }
}

/**
 * Grant, PUT, confirm - resumable from wherever the last attempt stopped,
 * because a manual retry should not upload forty megabytes twice for a
 * confirm that failed. State lives on the recording itself.
 */
async function upload(rec) {
  // A grant is good for fifteen minutes, so a retry pressed long after the
  // failure needs a fresh one - and a fresh grant is a fresh object.
  if (!rec.grant || Date.parse(rec.grant.expiresAt) - Date.now() < 60_000) {
    rec.grant = await retrying(() =>
      api.startRecording(rec.token, rec.deviceId, {
        bytes: rec.blob.size,
        durationMs: rec.durationMs
      })
    );
    rec.uploaded = false;
  }

  if (!rec.uploaded) {
    await retrying(() => put(rec.grant, rec.blob));
    rec.uploaded = true;
  }

  try {
    await retrying(() => api.confirmRecording(rec.token, rec.deviceId, rec.grant.eventId));
  } catch (err) {
    // The server could not find the bytes. Next time, send them again.
    if (err.status === 409) rec.uploaded = false;
    throw err;
  }
}

/**
 * Everyone audible, mixed onto one track: the recorder takes a single audio
 * track, and the people on a call come and go. Called whenever the set
 * changes, so a microphone opened mid-recording is heard from that moment
 * and one closed drops out.
 */
function syncMix({ ctx, dest, sources }, tracks) {
  for (const [track, node] of sources) {
    if (!tracks.includes(track)) {
      node.disconnect();
      sources.delete(track);
    }
  }
  for (const track of tracks) {
    if (sources.has(track) || track.readyState === 'ended') continue;
    const node = ctx.createMediaStreamSource(new MediaStream([track]));
    node.connect(dest);
    sources.set(track, node);
  }
}

const IDLE = 'idle';
// Asked for the turn, waiting to hear. Only a round trip, but the button
// must not take a second press in it.
const STARTING = 'starting';
const RECORDING = 'recording';
const SAVING = 'saving';
const SAVED = 'saved';
const FAILED = 'failed';

// How long "Saved to Activity" stays up before the line goes back to normal.
const SAVED_NOTICE_MS = 4000;

export function useLiveRecording({ token, deviceId, videoTrack, audioTracks }) {
  const [status, setStatus] = useState(IDLE);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState(null);
  // Offered when a save has failed for good, so the recording is never
  // simply lost: the file is still in this tab, and this hands it over.
  const [downloadUrl, setDownloadUrl] = useState(null);

  const active = useRef(null);
  const failed = useRef(null);
  const savedTimer = useRef(null);
  const mounted = useRef(true);
  // Read when a recording starts, so it begins with whoever is already
  // audible rather than waiting for the set to change.
  const audioRef = useRef(audioTracks);
  // The picture as it is now, for checking after the wait for the turn
  // that it is still the one the press was made on.
  const videoRef = useRef(videoTrack);

  const save = useCallback(async (rec) => {
    setStatus(SAVING);
    setError(null);
    try {
      await upload(rec);
      if (rec.downloadUrl) URL.revokeObjectURL(rec.downloadUrl);
      failed.current = null;
      setDownloadUrl(null);
      setStatus(SAVED);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(
        () => setStatus((s) => (s === SAVED ? IDLE : s)),
        SAVED_NOTICE_MS
      );
    } catch (err) {
      // Nobody left to offer the file to.
      if (!mounted.current) return;
      rec.downloadUrl ??= URL.createObjectURL(rec.blob);
      failed.current = rec;
      setDownloadUrl(rec.downloadUrl);
      setError(err.message || 'The recording could not be saved.');
      setStatus(FAILED);
    }
  }, []);

  const stop = useCallback(() => {
    const rec = active.current;
    if (!rec) return;
    active.current = null;
    clearInterval(rec.tick);
    clearTimeout(rec.limit);
    // onstop, below, takes it from here - the last of the data is only
    // handed over after stop() returns.
    if (rec.recorder.state !== 'inactive') rec.recorder.stop();
  }, []);

  const start = useCallback(async () => {
    if (active.current || !videoTrack) return;
    // One recording in hand at a time. A second started while the first is
    // still uploading - or has failed and is waiting on a decision - is how
    // one of them gets lost without anybody noticing.
    if (status === STARTING || status === SAVING || status === FAILED) return;

    const mimeType = pickMimeType();
    if (!mimeType) {
      setError(UNSUPPORTED);
      return;
    }
    setError(null);

    let ctx;
    try {
      // Made inside the press, before anything is awaited, so browsers that
      // want a gesture before they will run audio still see one.
      ctx = new AudioContext();
      ctx.resume().catch(() => {});
    } catch (err) {
      setError(err.message || 'Recording could not start.');
      return;
    }

    // Only then the turn. The server says no if somebody else is already
    // recording, and their name comes back in the refusal.
    setStatus(STARTING);
    try {
      await api.takeRecording(token, deviceId);
    } catch (err) {
      ctx.close().catch(() => {});
      if (mounted.current) {
        setStatus(IDLE);
        setError(err.message || 'Recording could not start.');
      }
      return;
    }

    // Given back on every way out from here on, so a recording that never
    // began cannot hold the turn for its full five minutes.
    const giveBack = () => retrying(() => api.releaseRecording(token, deviceId)).catch(() => {});

    // The call may have ended, or the page gone, while we waited.
    if (!mounted.current || videoRef.current !== videoTrack) {
      ctx.close().catch(() => {});
      giveBack();
      if (mounted.current) setStatus(IDLE);
      return;
    }

    let recorder;
    let mix;
    try {
      mix = { ctx, dest: ctx.createMediaStreamDestination(), sources: new Map() };
      syncMix(mix, audioRef.current);
      recorder = new MediaRecorder(
        new MediaStream([videoTrack, ...mix.dest.stream.getAudioTracks()]),
        {
          mimeType,
          videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
          audioBitsPerSecond: AUDIO_BITS_PER_SECOND
        }
      );
    } catch (err) {
      ctx.close().catch(() => {});
      giveBack();
      setStatus(IDLE);
      setError(err.message || 'Recording could not start.');
      return;
    }

    const chunks = [];
    const rec = {
      recorder,
      mix,
      videoTrack,
      startedAt: Date.now(),
      // Captured now: the recording belongs to the doorbell it was made
      // on, even if the page has moved to another by the time it uploads.
      token,
      deviceId
    };

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      // The turn goes back now, before the upload, so the next person can
      // start while this one is still on its way to the bucket.
      giveBack();
      mix.ctx.close().catch(() => {});
      // Stopped by the browser rather than by us - an error, a track that
      // ended - still passes through here, so tidy up the same way.
      if (active.current === rec) {
        active.current = null;
        clearInterval(rec.tick);
        clearTimeout(rec.limit);
      }

      const blob = new Blob(chunks, { type: 'video/mp4' });
      if (blob.size === 0) {
        if (mounted.current) {
          setStatus(IDLE);
          setError('Nothing was recorded.');
        }
        return;
      }
      save({
        blob,
        durationMs: Math.min(Date.now() - rec.startedAt, MAX_RECORDING_MS),
        token: rec.token,
        deviceId: rec.deviceId
      });
    };

    // No timeslice: the file is only any use whole, so there is nothing to
    // gain from having it handed over in pieces. It is held in memory
    // either way - five minutes is about 40MB.
    recorder.start();

    rec.tick = setInterval(() => setElapsedMs(Date.now() - rec.startedAt), 500);
    rec.limit = setTimeout(stop, MAX_RECORDING_MS);
    active.current = rec;
    clearTimeout(savedTimer.current);
    setElapsedMs(0);
    setStatus(RECORDING);
  }, [videoTrack, status, token, deviceId, stop, save]);

  // Voices joining and leaving mid-recording - mostly our own microphone,
  // which only exists while Talk is held.
  useEffect(() => {
    audioRef.current = audioTracks;
    if (active.current) syncMix(active.current.mix, audioTracks);
  }, [audioTracks]);

  // The picture went: End was pressed, the doorbell dropped, the call
  // reconnected onto a new track. Whatever was recorded until then is
  // kept and saved, rather than going on recording a frozen frame.
  useEffect(() => {
    videoRef.current = videoTrack;
    if (active.current && active.current.videoTrack !== videoTrack) stop();
  }, [videoTrack, stop]);

  // Leaving the page finishes the recording rather than discarding it. The
  // upload outlives the component - it is plain promises, not React state -
  // so moving to another page while it saves is fine. Closing the tab is
  // not, and nothing in a page can change that.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop();
      clearTimeout(savedTimer.current);
      if (failed.current?.downloadUrl) URL.revokeObjectURL(failed.current.downloadUrl);
    };
  }, [stop]);

  const retry = useCallback(() => {
    if (failed.current) save(failed.current);
  }, [save]);

  const discard = useCallback(() => {
    if (failed.current?.downloadUrl) URL.revokeObjectURL(failed.current.downloadUrl);
    failed.current = null;
    setDownloadUrl(null);
    setError(null);
    setStatus(IDLE);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    starting: status === STARTING,
    recording: status === RECORDING,
    saving: status === SAVING,
    saved: status === SAVED,
    failed: status === FAILED,
    elapsedMs,
    error,
    downloadUrl,
    start,
    stop,
    retry,
    discard,
    clearError
  };
}
