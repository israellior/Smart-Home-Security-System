import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLiveView } from '../hooks/useLiveView';
import styles from './LiveView.module.css';

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

        {!live.isLive && (
          <div className={styles.overlay}>
            {live.isIdle && !live.error && <p className={styles.hint}>Camera is off</p>}
            {live.isConnecting && <p className={styles.hint}>Connecting…</p>}
            {live.error && <p className={styles.error}>{live.error}</p>}
          </div>
        )}

        {/*
          * Connected to the room, but the doorbell has not shown up in it.
          *
          * The three messages here are three different situations and used
          * to be one. `deviceOnline` is the server's report that it wrote a
          * cue to a socket - not that anything read it - so a doorbell that
          * lost power thirty seconds ago still reports true, and this used
          * to sit on "Waiting for the camera" indefinitely. `unanswered` is
          * the only one of the three that knows the waiting is over.
          */}
        {live.isLive && !live.hasVideo && (
          <div className={styles.overlay}>
            {live.deviceOnline === false ? (
              <p className={styles.hint}>Your doorbell is offline — nothing is being sent</p>
            ) : live.unanswered ? (
              <>
                <p className={styles.hint}>Your doorbell didn’t answer</p>
                <button className={styles.overlayBtn} type="button" onClick={live.retry}>
                  Try again
                </button>
              </>
            ) : (
              <p className={styles.hint}>Waiting for the camera…</p>
            )}
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
