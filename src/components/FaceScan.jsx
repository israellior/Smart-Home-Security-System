import { useEffect, useRef, useState } from 'react';
import {
  measureFace,
  turn,
  tickOf,
  sectorOf,
  cropSquare,
  judgePixels,
  eyesOpen,
  choosePhotos,
  TICKS,
  SECTORS,
  STRAIGHT_UNDER,
  TURN_FROM,
  TURN_TO,
  TICK_AT,
  TOO_FAR,
  STRAIGHT_YAW_LIMIT,
  FACE_MIN,
  FACE_MAX,
  PHOTO_SIZE
} from '../lib/faceScan';
import styles from './FaceScan.module.css';

/*
 * A face scan in the manner of Face ID: the front camera in a circle, a ring
 * of ticks around it that fills as the head turns, twice round. What comes
 * out is a handful of square photos of one face - straight on and turned a
 * little each way - for the doorbell to learn; the doorbell makes its own
 * codes from them, so nothing here has to agree with its models.
 *
 * MediaPipe's Face Landmarker says where the face is and which way it points,
 * frame by frame, in the browser. It is loaded only when a scan starts - 15 MB
 * of WebAssembly and model is not something every visit to Settings pays for.
 * Nothing leaves this page until the scan is finished and `onCaptured` sends
 * the chosen photos.
 */

const BASE = import.meta.env.BASE_URL;
const WASM = `${BASE}mediapipe/wasm`;
const MODEL = `${BASE}mediapipe/face_landmarker.task`;

// Frames held looking straight ahead before the circle starts: what this
// face's "straight" is, and its straight-on photo, come from them.
const STRAIGHT_FRAMES = 15;
// A pass is done when this much of the ring is lit, or - for someone who
// cannot quite reach the last few ticks - most of it after a while.
const RING_DONE = 0.85;
const RING_ENOUGH = 0.6;
const PASS_PATIENCE_MS = 30000;
const BETWEEN_MS = 1600;
// Fewer than this and the doorbell has too little to go on: scan again.
const PHOTOS_MIN = 5;
// The face is judged for focus and light at this size, which is plenty and
// cheap enough to do on every frame.
const JUDGE_SIZE = 96;
const TOO_DARK = 45;
const TOO_BRIGHT = 225;
// Off-centre by more than this, as a fraction of the frame, and the face is
// out of the circle the preview shows.
const CENTRE_X = 0.18;
const CENTRE_Y = 0.2;

class ScanFailure extends Error {}

function describeFailure(err) {
  if (err instanceof ScanFailure) return err.message;
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was refused. Allow the camera for this site in your browser settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No front camera was found on this device.';
    case 'NotReadableError':
      return 'The camera is in use by another app. Close it and try again.';
    default:
      return 'The face scanner could not start. Check your connection and try again.';
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function createLandmarker(FaceLandmarker, files) {
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    // Two, so a second face in the picture can be noticed and refused.
    numFaces: 2,
    outputFaceBlendshapes: true,
    // Which way the head points, in degrees - see measureFace.
    outputFacialTransformationMatrixes: true
  });
  try {
    return await FaceLandmarker.createFromOptions(files, options('GPU'));
  } catch {
    // Some phones have no WebGL the model will run on; the CPU is slower
    // but quite fast enough for one face.
    return FaceLandmarker.createFromOptions(files, options('CPU'));
  }
}

function toJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not make a JPEG'))),
      'image/jpeg',
      0.92
    );
  });
}

/**
 * What the doorbell has made of the photos so far, in a sentence and a tone,
 * for the end of the scan. `learning` is from the parent, which hears the
 * doorbell's answers on the socket: null until the list has been fetched.
 */
function learningStatus(learning, name, doorbellName) {
  if (!learning) return { tone: 'busy', text: `Sending to ${doorbellName}…` };
  const { fresh, learned, usable, knownFrom } = learning;
  if (!learning.canRecognise) {
    return {
      tone: 'quiet',
      text: `${doorbellName} needs a software update before it can recognise faces. It will learn ${name}'s face after that.`
    };
  }
  if (learned < fresh) {
    if (!learning.online) {
      return { tone: 'quiet', text: `${doorbellName} is offline. It will learn ${name}'s face when it's back.` };
    }
    return { tone: 'busy', text: `${doorbellName} is learning ${name}'s face…`, progress: learned / fresh };
  }
  if (usable === 0) {
    return { tone: 'bad', text: `${doorbellName} couldn't use any of these photos. Try again in better light.` };
  }
  return {
    tone: 'good',
    text: `${doorbellName} knows ${name} now`,
    detail: `Recognised from ${knownFrom} photo${knownFrom === 1 ? '' : 's'}`
  };
}

/**
 * `onCaptured(photos, progress)` sends the photos - JPEG blobs - and calls
 * `progress(done, total)` as it goes; it resolves when they are saved and
 * rejects with a message worth showing if not. `maxPhotos` is how many the
 * person still has room for. `learning` is how the doorbell is getting on
 * with them - see learningStatus. `onRetry`, if given, offers another go
 * after a failure - by remounting this, which is the only way to start one.
 */
export function FaceScan({ name, doorbellName, maxPhotos, learning, onCaptured, onClose, onRetry }) {
  const videoRef = useRef(null);
  const [phase, setPhase] = useState('loading'); // loading straight circle between sending done failed
  const [pass, setPass] = useState(0);
  const [lit, setLit] = useState(() => new Array(TICKS).fill(false));
  const [prompt, setPrompt] = useState('Starting the camera…');
  const [failure, setFailure] = useState(null);
  const [sent, setSent] = useState({ done: 0, total: 0 });
  // The straight-on photo, shown in the circle once the camera is off.
  const [portrait, setPortrait] = useState(null);
  const [debug, setDebug] = useState(null);

  useEffect(() => () => portrait && URL.revokeObjectURL(portrait), [portrait]);

  useEffect(() => {
    let cancelled = false;
    let stream = null;
    let landmarker = null;
    let frame = 0;
    let lastVideoTime = -1;
    let betweenTimer = null;

    const judge = document.createElement('canvas');
    judge.width = JUDGE_SIZE;
    judge.height = JUDGE_SIZE;
    const judgeContext = judge.getContext('2d', { willReadFrequently: true });

    // Everything that changes every frame lives here rather than in state,
    // so a frame costs a render only when something on screen changes.
    const scan = {
      phase: 'loading',
      pass: 0,
      samples: [],
      straight: null,
      lit: [new Set(), new Set()],
      best: [new Map(), new Map()],
      passStartedAt: 0,
      prompt: ''
    };

    const say = (text) => {
      if (scan.prompt !== text) {
        scan.prompt = text;
        setPrompt(text);
      }
    };

    const stopCamera = () => {
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    };

    // Kept if it is the sharpest yet for its place in the scan.
    const offer = (bucket, video, face, crop) => {
      judgeContext.drawImage(video, face.box.x, face.box.y, face.box.w, face.box.h, 0, 0, JUDGE_SIZE, JUDGE_SIZE);
      const { sharpness, brightness } = judgePixels(
        judgeContext.getImageData(0, 0, JUDGE_SIZE, JUDGE_SIZE).data,
        JUDGE_SIZE
      );
      if (brightness < TOO_DARK) return 'dark';
      if (brightness > TOO_BRIGHT) return 'bright';
      const kept = scan.best[scan.pass];
      const current = kept.get(bucket);
      if (current && current.sharpness >= sharpness) return 'ok';
      const canvas = current?.canvas ?? document.createElement('canvas');
      canvas.width = PHOTO_SIZE;
      canvas.height = PHOTO_SIZE;
      canvas
        .getContext('2d')
        .drawImage(video, crop.x, crop.y, crop.side, crop.side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
      kept.set(bucket, { bucket, sharpness, canvas });
      return 'ok';
    };

    const finish = async () => {
      scan.phase = 'sending';
      setPhase('sending');
      stopCamera();
      const chosen = choosePhotos(
        scan.best.map((kept) => [...kept.values()]),
        maxPhotos
      );
      if (chosen.length < Math.min(PHOTOS_MIN, maxPhotos)) {
        setFailure('Not enough clear pictures came out of that. Try somewhere brighter, holding the phone steady at arm\'s length.');
        setPhase('failed');
        return;
      }
      try {
        const photos = await Promise.all(chosen.map((p) => toJpeg(p.canvas)));
        if (cancelled) return;
        // choosePhotos puts straight on first.
        setPortrait(URL.createObjectURL(photos[0]));
        setSent({ done: 0, total: photos.length });
        await onCaptured(photos, (done, total) => !cancelled && setSent({ done, total }));
        if (!cancelled) setPhase('done');
      } catch (err) {
        if (cancelled) return;
        setFailure(err?.message || 'The photos could not be saved. Try again.');
        setPhase('failed');
      }
    };

    const endPass = () => {
      if (scan.pass === 0) {
        scan.phase = 'between';
        setPhase('between');
        say('Once more — slowly round the circle again');
        betweenTimer = setTimeout(() => {
          scan.pass = 1;
          scan.phase = 'circle';
          scan.passStartedAt = performance.now();
          setPass(1);
          setLit(new Array(TICKS).fill(false));
          setPhase('circle');
        }, BETWEEN_MS);
        return;
      }
      finish();
    };

    const step = () => {
      frame = requestAnimationFrame(step);
      const video = videoRef.current;
      if (!video || video.readyState < 2 || video.currentTime === lastVideoTime) return;
      if (scan.phase !== 'straight' && scan.phase !== 'circle') return;
      lastVideoTime = video.currentTime;

      const width = video.videoWidth;
      const height = video.videoHeight;
      const result = landmarker.detectForVideo(video, performance.now());
      const found = result.faceLandmarks ?? [];
      if (found.length === 0) return say('Put your face in the circle');
      if (found.length > 1) return say('Only one face, please');

      const face = measureFace(found[0], result.facialTransformationMatrixes?.[0], width, height);
      if (!face) return;
      const size = Math.max(face.box.w, face.box.h) / Math.min(width, height);
      if (size < FACE_MIN) return say('Come a little closer');
      if (size > FACE_MAX) return say('Move back a little');
      const cx = (face.box.x + face.box.w / 2) / width;
      const cy = (face.box.y + face.box.h / 2) / height;
      if (Math.abs(cx - 0.5) > CENTRE_X || Math.abs(cy - 0.5) > CENTRE_Y) {
        return say('Move your face into the circle');
      }
      const crop = cropSquare(face.box, width, height);
      const open = eyesOpen(result.faceBlendshapes?.[0]);

      if (scan.phase === 'straight') {
        if (Math.abs(face.yaw) > STRAIGHT_YAW_LIMIT) return say('Look straight at the screen');
        say('Hold still, looking at the screen');
        scan.samples.push(face);
        if (crop && open) {
          const verdict = offer('straight', video, face, crop);
          if (verdict === 'dark') return say('It is too dark here — find a brighter spot');
          if (verdict === 'bright') return say('Too much light behind or on you — turn a little');
        }
        if (scan.samples.length >= STRAIGHT_FRAMES) {
          // Medians, so one frame mid-blink or mid-move does not set it.
          scan.straight = {
            yaw: median(scan.samples.map((s) => s.yaw)),
            pitch: median(scan.samples.map((s) => s.pitch))
          };
          scan.phase = 'circle';
          scan.passStartedAt = performance.now();
          setPhase('circle');
        }
        return;
      }

      const t = turn(face, scan.straight);
      if (import.meta.env.DEV) {
        setDebug(
          `${t.degrees.toFixed(0)}° at ${((t.angle * 180) / Math.PI).toFixed(0)}° · ` +
            `right ${t.dx.toFixed(0)} down ${t.dy.toFixed(0)} · face ${(size * 100).toFixed(0)}% · ` +
            `photos ${scan.best[scan.pass].size}`
        );
      }
      const ticks = scan.lit[scan.pass];
      if (t.degrees >= TICK_AT) {
        const tick = tickOf(t.angle);
        if (!ticks.has(tick)) {
          ticks.add(tick);
          setLit((previous) => {
            const next = [...previous];
            next[tick] = true;
            return next;
          });
        }
      }
      if (crop && open) {
        let bucket = null;
        if (t.degrees < STRAIGHT_UNDER) bucket = 'straight';
        else if (t.degrees >= TURN_FROM && t.degrees <= TURN_TO) bucket = sectorOf(t.angle);
        const verdict = bucket === null ? 'ok' : offer(bucket, video, face, crop);
        if (verdict === 'dark') return say('It is too dark here — find a brighter spot');
        if (verdict === 'bright') return say('Too much light behind or on you — turn a little');
      }
      say(t.degrees > TOO_FAR ? 'Not so far — a gentle circle' : 'Slowly move your head round the circle');

      const fraction = ticks.size / TICKS;
      const sectors = [...scan.best[scan.pass].keys()].filter((k) => k !== 'straight').length;
      const patient = performance.now() - scan.passStartedAt > PASS_PATIENCE_MS;
      if (fraction >= RING_DONE || (patient && fraction >= RING_ENOUGH && sectors >= SECTORS - 2)) {
        endPass();
      }
    };

    (async () => {
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new ScanFailure('The camera only works on a secure (https) page.');
        }
        const media = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false
        });
        // Strict mode, or a fast Cancel: this run was abandoned while the
        // browser asked for permission, and nothing else will stop it.
        if (cancelled) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = media;
        const video = videoRef.current;
        video.srcObject = stream;
        await video.play();

        say('Loading the face scanner…');
        const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
        const files = await FilesetResolver.forVisionTasks(WASM);
        const made = await createLandmarker(FaceLandmarker, files);
        if (cancelled) {
          made.close();
          return;
        }
        landmarker = made;
        scan.phase = 'straight';
        setPhase('straight');
        say('Put your face in the circle');
        frame = requestAnimationFrame(step);
      } catch (err) {
        if (cancelled) return;
        stopCamera();
        setFailure(describeFailure(err));
        setPhase('failed');
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(betweenTimer);
      stopCamera();
      landmarker?.close();
    };
    // One scan per mount: the parent remounts this for another go, so the
    // props it read at the start are the ones the scan is for.
  }, []);

  const scanning = phase === 'straight' || phase === 'circle' || phase === 'between' || phase === 'loading';
  const finished = phase === 'sending' || phase === 'done';

  // The ring: the head's progress while scanning, the upload's while
  // sending - brass filling round - and whole and green once it is done.
  let ticks = lit;
  let litClass = pass === 0 ? styles.litFirst : styles.litSecond;
  if (phase === 'sending') {
    const filled = sent.total ? Math.round((sent.done / sent.total) * TICKS) : 0;
    ticks = lit.map((_, i) => i < filled);
    litClass = styles.litFirst;
  } else if (phase === 'done') {
    ticks = lit.map(() => true);
    litClass = styles.litSecond;
  }

  const status = phase === 'done' ? learningStatus(learning, name, doorbellName) : null;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={`Face scan for ${name}`}>
      <div className={styles.top}>
        {phase !== 'done' && phase !== 'failed' && (
          <button type="button" className={styles.cancel} onClick={onClose}>
            Cancel
          </button>
        )}
        {scanning && phase !== 'loading' && <span className={styles.passNote}>Scan {pass + 1} of 2</span>}
      </div>

      <div className={styles.body}>
        {(scanning || finished) && (
          <div className={styles.stage}>
            {scanning && <video ref={videoRef} className={styles.video} playsInline muted />}
            {finished && portrait && <img className={styles.video} src={portrait} alt="" />}
            <svg className={styles.ring} viewBox="-100 -100 200 200" aria-hidden="true">
              {ticks.map((on, i) => {
                const angle = (i / TICKS) * 2 * Math.PI;
                const cos = Math.cos(angle);
                const sin = Math.sin(angle);
                return (
                  <line
                    key={i}
                    x1={cos * 88}
                    y1={sin * 88}
                    x2={cos * 97}
                    y2={sin * 97}
                    className={on ? litClass : styles.tick}
                  />
                );
              })}
            </svg>
            {phase === 'done' && (
              <svg className={styles.badge} viewBox="0 0 48 48" aria-hidden="true">
                <circle cx="24" cy="24" r="22" />
                <path d="M14 24.5 L21 31.5 L34 17.5" />
              </svg>
            )}
          </div>
        )}

        <div className={styles.words} aria-live="polite">
          {scanning && <p className={styles.prompt}>{prompt}</p>}
          {phase === 'sending' && (
            <p className={styles.prompt}>
              Saving the photos{sent.total ? ` — ${sent.done} of ${sent.total}` : '…'}
            </p>
          )}
          {phase === 'done' && (
            <>
              <p className={styles.title}>Scan complete</p>
              <p className={styles.detail}>
                {sent.total} photos of {name} saved.
              </p>
              <div className={`${styles.status} ${styles[`status_${status.tone}`]}`}>
                <p className={styles.statusText}>{status.text}</p>
                {status.detail && <p className={styles.statusDetail}>{status.detail}</p>}
                {status.progress !== undefined && (
                  <span className={styles.bar} aria-hidden="true">
                    <span style={{ width: `${Math.round(status.progress * 100)}%` }} />
                  </span>
                )}
              </div>
            </>
          )}
          {phase === 'failed' && (
            <>
              <p className={styles.title}>The scan didn&apos;t work</p>
              <p className={styles.detail}>{failure}</p>
            </>
          )}
          {debug && scanning && <p className={styles.debug}>{debug}</p>}
        </div>
      </div>

      {phase === 'done' && (
        <div className={styles.bottom}>
          {status.tone === 'bad' && onRetry && (
            <button type="button" className={styles.secondary} onClick={onRetry}>
              Scan again
            </button>
          )}
          <button type="button" className={styles.primary} onClick={onClose}>
            Done
          </button>
        </div>
      )}
      {phase === 'failed' && (
        <div className={styles.bottom}>
          {onRetry && (
            <button type="button" className={styles.primary} onClick={onRetry}>
              Try again
            </button>
          )}
          <button type="button" className={styles.secondary} onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
