import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLiveView } from '../hooks/useLiveView';
import { AlertIcon, BellIcon, CameraIcon, CameraOffIcon, WifiOffIcon } from './Icons';
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
export function LiveView({ device, expanded = false, onCollapse }) {
  const { token } = useAuth();
  const live = useLiveView(token, device._id);
  const closeRef = useRef(null);

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

  return (
    <div
      className={expanded ? styles.full : styles.wrap}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded ? 'true' : undefined}
      aria-label={expanded ? `${device.name}, live` : undefined}
    >
      {expanded && (
        <button
          ref={closeRef}
          className={styles.close}
          type="button"
          onClick={onCollapse}
          aria-label="Leave full screen"
        >
          ×
        </button>
      )}

      <div
        className={`${styles.stage} ${live.isLive ? styles.stageLive : ''} ${
          expanded ? styles.stageFull : ''
        }`}
      >
        {/* Always mounted: the refs have to exist before a track arrives,
            and a track that arrives with nowhere to attach is silent. */}
        <video
          ref={live.videoRef}
          className={`${styles.video} ${live.hasVideo ? styles.videoOn : ''}`}
          autoPlay
          playsInline
          muted
        />
        <audio ref={live.audioRef} autoPlay />

        {!live.hasVideo && <StageStatus live={live} deviceName={device.name} />}

        {live.hasVideo && (
          <span className={`${styles.liveBadge} ${expanded ? styles.liveBadgeFull : ''}`}>
            <span className={styles.liveDot} aria-hidden="true" />
            Live
          </span>
        )}

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
            <button className={styles.secondary} type="button" onClick={live.stop}>
              End
            </button>
          </>
        )}
      </div>

      {/* Errors raised while live have to be shown here: the overlay
          above only renders before the session is up, so until now a
          failed talk attempt set an error message that nothing on the
          page could ever display, and holding the button looked exactly
          like holding a button that did nothing. */}
      {live.isLive && (
        <p
          className={`${live.error ? styles.noteError : styles.note} ${
            expanded ? styles.noteFull : ''
          }`}
        >
          {live.error || (live.talking ? 'They can hear you.' : 'Hold the button to speak.')}
        </p>
      )}
    </div>
  );
}
