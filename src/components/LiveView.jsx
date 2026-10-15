import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLiveView } from '../hooks/useLiveView';
import { useLiveRecording } from '../hooks/useLiveRecording';
import { wifiSignal } from '../lib/wifiSignal';
import { useDeviceLive } from './DeviceLayout';
import {
  AlertIcon,
  BellIcon,
  CameraIcon,
  CameraOffIcon,
  ExpandIcon,
  EyeIcon,
  FillIcon,
  FitIcon,
  MicIcon,
  RecordIcon,
  WifiIcon,
  WifiOffIcon
} from './Icons';
import styles from './LiveView.module.css';

/*
 * The three things a start waits on, in the order they happen. Each one is
 * a real signal from the hook rather than a timer dressed up as progress:
 * the room join, the doorbell's participant arriving, its first frame.
 */
const STEPS = ['Connect', 'Wake doorbell', 'Video'];

/**
 * Everything the stage says while there is no picture to show.
 *
 * One place that decides which situation this is, because they used to be
 * scattered across two overlays that could, in the wrong order of events,
 * both render. The cases below are mutually exclusive by construction.
 *
 * `deviceOnline` is the server's report that it wrote a cue to a socket -
 * not that anything read it - so it can only ever say "offline", never
 * "on its way". `unanswered` is the only signal that knows the waiting is
 * over.
 */
function StageStatus({ live, deviceName }) {
  let view;

  if (live.error && !live.isLive) {
    view = {
      tone: 'bad',
      icon: <AlertIcon size={26} />,
      title: 'Couldn’t connect',
      detail: live.error,
      action: { label: 'Try again', onClick: live.retry }
    };
  } else if (live.isIdle) {
    view = {
      tone: 'quiet',
      icon: <CameraIcon size={26} />,
      title: 'Camera is off',
      detail: 'Press View live to see who’s at the door.'
    };
  } else if (live.isLive && live.deviceOnline === false) {
    view = {
      tone: 'bad',
      icon: <WifiOffIcon size={26} />,
      title: `${deviceName} is offline`,
      detail: 'Check that it has power and is in range of your Wi-Fi.',
      action: { label: 'Try again', onClick: live.retry }
    };
  } else if (live.isLive && live.unanswered) {
    view = {
      tone: 'bad',
      icon: <CameraOffIcon size={26} />,
      title: 'Your doorbell didn’t answer',
      detail: 'It may have lost power or Wi-Fi. Trying again is safe.',
      action: { label: 'Try again', onClick: live.retry }
    };
  } else {
    const step = live.isConnecting ? 0 : live.doorbellJoined ? 2 : 1;
    view = {
      tone: 'busy',
      step,
      icon: step === 1 ? <BellIcon size={26} /> : <CameraIcon size={26} />,
      title: ['Connecting…', `Waking up ${deviceName}`, 'Starting video'][step],
      detail: [
        'Opening a private connection to your doorbell.',
        'It rests between visits, so this takes a few seconds.',
        'The picture will appear in a moment.'
      ][step]
    };
  }

  return (
    <div className={`${styles.status} ${styles[`tone_${view.tone}`]}`}>
      <div className={styles.statusIcon}>
        {view.tone === 'busy' && (
          <>
            <span className={styles.pulse} aria-hidden="true" />
            <span className={`${styles.pulse} ${styles.pulseLate}`} aria-hidden="true" />
          </>
        )}
        {view.icon}
      </div>

      {/* Polite: a screen reader hears each step as it changes, without the
          interruption an alert would make of something this routine. */}
      <p className={styles.statusTitle} role="status" aria-live="polite">
        {view.title}
      </p>
      <p className={styles.statusDetail}>{view.detail}</p>

      {view.step !== undefined && (
        <ol className={styles.steps} aria-label="Progress">
          {STEPS.map((label, i) => (
            <li
              key={label}
              className={
                i < view.step ? styles.stepDone : i === view.step ? styles.stepNow : styles.step
              }
              aria-current={i === view.step ? 'step' : undefined}
            >
              <span className={styles.stepBar} aria-hidden="true" />
              <span className={styles.stepLabel}>{label}</span>
            </li>
          ))}
        </ol>
      )}

      {view.action && (
        <button className={styles.overlayBtn} type="button" onClick={view.action.onClick}>
          {view.action.label}
        </button>
      )}
    </div>
  );
}

const pad = (n) => String(n).padStart(2, '0');

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

/**
 * The line under the controls, which has more to say than it used to.
 *
 * A recording's news outranks the talk hint because it is the thing that
 * can be lost: a save that failed has to stay on screen with its way out
 * until somebody chooses one. And it is shown whether or not the call is
 * still up - pressing End is the most natural way to stop recording, and
 * the save carries on after it.
 */
function Note({ live, rec, othersRecording, expanded }) {
  const fullClass = expanded ? styles.noteFull : '';

  if (rec.failed) {
    return (
      <div className={`${styles.noteError} ${fullClass}`} role="alert">
        <p className={styles.noteText}>Your recording wasn’t saved. {rec.error}</p>
        <div className={styles.noteActions}>
          <button type="button" className={styles.noteBtn} onClick={rec.retry}>
            Try again
          </button>
          {rec.downloadUrl && (
            <a className={styles.noteBtn} href={rec.downloadUrl} download="porchlight-recording.mp4">
              Download
            </a>
          )}
          <button type="button" className={styles.noteBtn} onClick={rec.discard}>
            Discard
          </button>
        </div>
      </div>
    );
  }

  let text = null;
  let tone = styles.note;
  if (live.isLive && live.error) {
    text = live.error;
    tone = styles.noteError;
  } else if (rec.error) {
    text = rec.error;
    tone = styles.noteError;
  } else if (rec.saving) {
    text = 'Saving your recording to Activity…';
  } else if (rec.saved) {
    text = 'Saved to Activity. Everyone on this doorbell can watch it.';
  } else if (rec.recording) {
    text = live.talking
      ? 'Recording, with your voice. They can hear you.'
      : 'Recording. It will be saved to Activity for everyone on this doorbell.';
  } else if (live.isLive && othersRecording) {
    // Said to everyone else on the call, because their voice is in it too
    // the moment they hold Talk.
    const who = othersRecording.name || 'Someone';
    text = live.talking
      ? `${who} is recording, and your voice is included.`
      : `${who} is recording. Anything you say will be included.`;
  } else if (live.isLive) {
    text = live.talking ? 'They can hear you.' : 'Hold the button to speak.';
  }

  if (!text) return null;
  return (
    <p className={`${tone} ${fullClass}`} role={rec.saving || rec.saved ? 'status' : undefined}>
      {text}
    </p>
  );
}


// How many names fit in the pill before the rest become a count. Three is
// about what a phone's top bar holds beside the Live badge, and a doorbell
// rarely has more people on it than that anyway.
const NAMES_SHOWN = 3;

/**
 * Who is watching, over the picture.
 *
 * People rather than connections: the same person on a phone and a laptop
 * is one name. "Just you" is said rather than the pill going away, because
 * knowing nobody else is looking is half of what this is for - it is the
 * difference between talking to a visitor and talking to a visitor with
 * your family listening.
 */
function Viewers({ viewers, talker }) {
  if (viewers.length === 0) return null;

  const others = viewers.filter((v) => !v.isMe);
  const named = viewers.map((v) => (v.isMe ? 'You' : v.name));
  const label =
    others.length === 0
      ? 'Only you are watching'
      : `Watching now: ${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;

  const shown = viewers.slice(0, NAMES_SHOWN);
  const more = viewers.length - shown.length;

  return (
    <span className={styles.viewers} role="status" aria-label={label}>
      <EyeIcon size={13} />
      {others.length === 0 ? (
        <span>Just you</span>
      ) : (
        <span className={styles.viewerNames} aria-hidden="true">
          {shown.map((v, i) => (
            <span key={v.userId} className={styles.viewerName}>
              {i > 0 && ', '}
              {/* Whose voice the doorbell is playing. Shown on the name,
                  because "someone is talking" is less use than who. */}
              {v.userId === talker && <MicIcon size={11} />}
              {v.isMe ? 'You' : v.name}
            </span>
          ))}
          {more > 0 && <span className={styles.viewerMore}> +{more}</span>}
        </span>
      )}
    </span>
  );
}

// How long full screen waits with nothing happening before the buttons get
// out of the picture's way. Long enough to read them and reach for one.
const CHROME_IDLE_MS = 3500;

// A phone held sideways. Coarse pointer and a short screen, so a desktop
// window that happens to be wider than it is tall never jumps into full
// screen on its own.
const PHONE_LANDSCAPE = '(orientation: landscape) and (pointer: coarse) and (max-height: 540px)';

/**
 * The doorbell's camera, and the button that lets you answer it.
 *
 * Talk is push-to-talk: hold to speak, release to give the floor back.
 * Deliberately not a toggle - a toggle left on is a microphone in
 * someone's hallway that nobody remembers switching on, and with the
 * floor being exclusive it would also lock everyone else out.
 *
 * `expanded` fills the screen with the same player rather than opening
 * a second one. That distinction is the whole point: one LiveView means
 * one useLiveView means one room, so going full screen and coming back
 * never reconnects, and the doorbell never sees a viewer leave and
 * rejoin because someone tapped the ring.
 */
export function LiveView({ device, expanded = false, onExpand, onCollapse }) {
  const { token, user } = useAuth();
  const live = useLiveView(token, device._id);
  // Who holds the one recording turn, from the doorbell's socket. Only
  // somebody else holding it matters here - our own turn is already
  // known to useLiveRecording.
  const { recorder, talker, rssi } = useDeviceLive();
  const othersRecording = recorder && recorder.userId !== user?.id ? recorder : null;
  const signal = wifiSignal(rssi);
  // Fed from the call rather than from the <video>: the same tracks, but
  // these say when they change, and a recording has to follow voices as
  // they join and leave.
  const rec = useLiveRecording({
    token,
    deviceId: device._id,
    videoTrack: live.videoTrack,
    audioTracks: live.audioTracks
  });
  const rootRef = useRef(null);
  const closeRef = useRef(null);
  // Fit shows the whole picture with bars; fill crops to the screen. Only
  // offered full screen, where the two differ - inline the stage is
  // already the picture's shape.
  const [fill, setFill] = useState(false);

  // "Dana is already recording" stops being true when Dana stops, and the
  // refusal should not outlive it.
  const othersId = othersRecording?.userId ?? null;
  const { clearError } = rec;
  useEffect(() => {
    if (!othersId) clearError();
  }, [othersId, clearError]);

  const talkHandlers = {
    onPointerDown: live.startTalking,
    // Both, because a pointer released outside the button never fires
    // pointerup on it - and a stuck-down talk button is the one failure
    // here with a privacy cost.
    onPointerUp: live.stopTalking,
    onPointerLeave: () => live.talking && live.stopTalking(),
    onPointerCancel: live.stopTalking
  };

  /*
   * Filling the screen is itself the request to watch, so it connects on
   * its own: opening the live view and then having to press "View live"
   * inside it asks the same question twice.
   *
   * Latched on a ref rather than read off the phase. Keyed on isIdle,
   * this would restart the session the instant someone pressed End
   * without leaving full screen, and there would be no way to stop
   * watching short of backing out of the page.
   */
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!expanded) {
      autoStarted.current = false;
      return;
    }
    if (autoStarted.current) return;
    autoStarted.current = true;
    if (live.isIdle) live.start();
    closeRef.current?.focus();
  }, [expanded, live]);

  /*
   * Escape closes anything that fills the screen. Closing stops the
   * watching, not the session - the stream is still up in the inline
   * player underneath - so End and the close button are two different
   * buttons rather than one doing both jobs.
   */
  useEffect(() => {
    if (!expanded) return;

    const onKey = (e) => {
      if (e.key === 'Escape') onCollapse?.();
    };
    window.addEventListener('keydown', onKey);

    // The page behind stays scrollable otherwise, and on a phone a drag
    // anywhere on the video scrolls it out from under your finger.
    const restore = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = restore;
    };
  }, [expanded, onCollapse]);

  /*
   * The browser's own full screen, on top of ours, where there is one.
   *
   * The overlay alone fills the window but not the screen: on a phone the
   * address bar and the system bars stay, and they are a fifth of a
   * landscape screen. Asked for in the same moment as the tap that opened
   * this, because browsers only grant it to a gesture.
   *
   * iPhone Safari has no full screen for anything but its own video
   * player, which would take Talk and Rec away with it. There the overlay
   * is the whole of it, and `requestFullscreen` being absent is how that
   * is known - not a user-agent check.
   *
   * Leaving the browser's full screen - the back gesture, Escape, the
   * system's own button - leaves ours too, or it would strand the overlay
   * behind bars that just came back.
   */
  useEffect(() => {
    if (!expanded) return undefined;
    const el = rootRef.current;
    if (!el?.requestFullscreen || document.fullscreenElement) return undefined;

    let entered = false;
    const onChange = () => {
      if (document.fullscreenElement === el) entered = true;
      else if (entered) onCollapse?.();
    };
    document.addEventListener('fullscreenchange', onChange);
    // Refused without a fresh gesture - turning the phone sideways is not
    // one - and the overlay is still a perfectly good full screen then.
    el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});

    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
    };
  }, [expanded, onCollapse]);

  /*
   * Turning the phone sideways while watching fills the screen, and
   * turning it back undoes exactly that - but only that. Somebody who
   * opened full screen on purpose and then turned the phone upright has
   * not asked to leave.
   *
   * Only while a call is up: a phone turned on the doorbell's page is not
   * a request to wake the camera.
   */
  const rotatedIn = useRef(false);
  useEffect(() => {
    if (!expanded) rotatedIn.current = false;
  }, [expanded]);

  useEffect(() => {
    if (!onExpand || !window.matchMedia) return undefined;
    const query = window.matchMedia(PHONE_LANDSCAPE);
    const onTurn = () => {
      if (query.matches && live.isLive && !expanded) {
        rotatedIn.current = true;
        onExpand();
      } else if (!query.matches && expanded && rotatedIn.current) {
        rotatedIn.current = false;
        onCollapse?.();
      }
    };
    query.addEventListener('change', onTurn);
    return () => query.removeEventListener('change', onTurn);
  }, [live.isLive, expanded, onExpand, onCollapse]);

  /*
   * Full screen's buttons step out of the picture after a few quiet
   * seconds, the way any video player's do, and a tap brings them back.
   *
   * Never while they are the point: before there is a picture, while
   * holding Talk, or while there is something on screen that has to be
   * read or answered - a failed save in particular offers its only way
   * out down there. The Live and Rec badges stay regardless; being
   * recorded is not something to be unsure of because the controls
   * happened to fade.
   */
  const canHide =
    expanded &&
    live.hasVideo &&
    !live.talking &&
    !live.error &&
    !rec.failed &&
    !rec.error &&
    !rec.saving;
  const [chromeShown, setChromeShown] = useState(true);
  const hideTimer = useRef(null);

  const showChrome = useCallback(() => {
    setChromeShown(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setChromeShown(false), CHROME_IDLE_MS);
  }, []);

  useEffect(() => {
    if (!canHide) {
      clearTimeout(hideTimer.current);
      setChromeShown(true);
      return undefined;
    }
    showChrome();
    return () => clearTimeout(hideTimer.current);
  }, [canHide, showChrome]);

  const chromeHidden = canHide && !chromeShown;

  const onStageClick = (e) => {
    if (!canHide || e.target.closest('button, a')) return;
    if (chromeHidden) {
      showChrome();
    } else {
      clearTimeout(hideTimer.current);
      setChromeShown(false);
    }
  };

  const fullHandlers = expanded
    ? {
        // A mouse moving is somebody looking for the buttons. A finger is
        // not: it moves on its way to a tap, and the tap decides.
        onPointerMove: (e) => e.pointerType === 'mouse' && canHide && showChrome(),
        // Keyboard users tab into buttons they cannot see otherwise.
        onFocus: () => canHide && showChrome()
      }
    : {};

  const chromeClass = `${styles.chrome} ${chromeHidden ? styles.chromeHidden : ''}`;

  const controls = (
    <div className={`${styles.controls} ${expanded ? styles.controlsFull : ''}`}>
      {!live.isLive ? (
        <button
          className={styles.primary}
          type="button"
          onClick={live.start}
          disabled={live.isConnecting}
        >
          {live.isConnecting ? 'Connecting…' : 'View live'}
        </button>
      ) : (
        <>
          <button
            className={`${styles.talk} ${live.talking ? styles.talkOn : ''}`}
            type="button"
            {...talkHandlers}
          >
            {live.talking ? 'Release to stop' : 'Hold to talk'}
          </button>
          {/* A toggle, unlike Talk: a recording is meant to run while you
              do other things, including talking. It stops itself when the
              picture goes and at the length limit, so it cannot be left
              running by accident. */}
          <button
            className={`${styles.record} ${rec.recording ? styles.recordOn : ''}`}
            type="button"
            onClick={rec.recording ? rec.stop : rec.start}
            disabled={
              !rec.recording &&
              (!live.hasVideo || rec.starting || rec.saving || rec.failed || Boolean(othersRecording))
            }
            aria-pressed={rec.recording}
            aria-label={
              rec.recording
                ? `Stop recording, ${formatElapsed(rec.elapsedMs)} recorded`
                : othersRecording
                  ? `${othersRecording.name || 'Someone else'} is recording`
                  : 'Record'
            }
          >
            <RecordIcon size={16} />
            {rec.recording
              ? formatElapsed(rec.elapsedMs)
              : rec.saving
                ? 'Saving'
                : rec.starting
                  ? 'Rec…'
                  : 'Rec'}
          </button>
          <button className={styles.secondary} type="button" onClick={live.stop}>
            End
          </button>
        </>
      )}
    </div>
  );

  // Errors raised while live have to be shown here: the overlay on the
  // stage only renders before the session is up, so a failed talk attempt
  // would otherwise set an error that nothing on the page displays, and
  // holding the button would look exactly like holding one that did
  // nothing.
  const note = <Note live={live} rec={rec} othersRecording={othersRecording} expanded={expanded} />;

  return (
    <div
      ref={rootRef}
      className={`${expanded ? styles.full : styles.wrap} ${
        chromeHidden ? styles.cursorHidden : ''
      }`}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded ? 'true' : undefined}
      aria-label={expanded ? `${device.name}, live` : undefined}
      {...fullHandlers}
    >
      <div
        className={`${styles.stage} ${live.isLive ? styles.stageLive : ''} ${
          expanded ? styles.stageFull : ''
        }`}
        onClick={expanded ? onStageClick : undefined}
      >
        {/* Always mounted: the refs have to exist before a track arrives,
            and a track that arrives with nowhere to attach is silent. */}
        <video
          ref={live.videoRef}
          className={`${styles.video} ${live.hasVideo ? styles.videoOn : ''} ${
            expanded && fill ? styles.videoFill : ''
          }`}
          autoPlay
          playsInline
          muted
        />
        <audio ref={live.audioRef} autoPlay />

        {!live.hasVideo && <StageStatus live={live} deviceName={device.name} />}

        <div className={`${styles.topBar} ${expanded ? styles.topBarFull : ''}`}>
          <div className={styles.badges}>
            {live.hasVideo && (
              <span className={styles.liveBadge}>
                <span className={styles.liveDot} aria-hidden="true" />
                Live
                {/* On the picture as well as on the button, because the
                    picture is where you are looking - and being recorded is
                    something the person holding the phone should never be
                    unsure of. */}
                {rec.recording && (
                  <span className={styles.recTag}>Rec {formatElapsed(rec.elapsedMs)}</span>
                )}
                {othersRecording && <span className={styles.recTag}>Rec</span>}
              </span>
            )}
            {live.hasVideo && <Viewers viewers={live.viewers} talker={talker} />}
            {/* Only when it is the likely reason the picture is struggling.
                A good signal is the device page's to mention; here it would
                be one more thing on top of somebody's front door. */}
            {live.hasVideo && signal?.weak && (
              <span className={styles.weakSignal} title={`${signal.rssi} dBm`}>
                <WifiIcon size={13} level={signal.level} />
                Weak Wi-Fi
              </span>
            )}
          </div>

          <div className={`${styles.tools} ${expanded ? chromeClass : ''}`}>
            {expanded ? (
              <>
                {live.hasVideo && (
                  <button
                    className={styles.tool}
                    type="button"
                    onClick={() => setFill((f) => !f)}
                    aria-pressed={fill}
                    aria-label={fill ? 'Show the whole picture' : 'Fill the screen'}
                  >
                    {fill ? <FitIcon size={18} /> : <FillIcon size={18} />}
                  </button>
                )}
                <button
                  ref={closeRef}
                  className={styles.tool}
                  type="button"
                  onClick={onCollapse}
                  aria-label="Leave full screen"
                >
                  <span className={styles.closeGlyph} aria-hidden="true">
                    ×
                  </span>
                </button>
              </>
            ) : (
              onExpand && (
                <button
                  className={styles.tool}
                  type="button"
                  onClick={onExpand}
                  aria-label={`Watch ${device.name} full screen`}
                >
                  <ExpandIcon size={17} />
                </button>
              )
            )}
          </div>
        </div>

        {/* Over the frozen last frame rather than replacing it: the picture
            is still the most useful thing on screen, and it is about to
            start moving again. */}
        {live.hasVideo && live.reconnecting && (
          <div className={styles.reconnecting} role="status">
            <span className={styles.spinner} aria-hidden="true" />
            Reconnecting…
          </div>
        )}
      </div>

      {/* Full screen lays the controls over the picture rather than under
          it, so the picture can have the whole screen. */}
      {expanded ? (
        <div className={`${styles.dock} ${chromeClass}`}>
          {controls}
          {note}
        </div>
      ) : (
        <>
          {controls}
          {note}
        </>
      )}
    </div>
  );
}
