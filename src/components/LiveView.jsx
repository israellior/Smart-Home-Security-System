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
 */
export function LiveView({ device }) {
  const { token } = useAuth();
  const live = useLiveView(token, device._id);

  const talkHandlers = {
    onPointerDown: live.startTalking,
    // Both, because a pointer released outside the button never fires
    // pointerup on it - and a stuck-down talk button is the one failure
    // here with a privacy cost.
    onPointerUp: live.stopTalking,
    onPointerLeave: () => live.talking && live.stopTalking(),
    onPointerCancel: live.stopTalking
  };

  return (
    <div className={styles.wrap}>
      <div className={`${styles.stage} ${live.isLive ? styles.stageLive : ''}`}>
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

        {live.isLive && !live.hasVideo && (
          <div className={styles.overlay}>
            <p className={styles.hint}>
              {live.deviceOnline === false
                ? 'Your doorbell is offline — nothing is being sent'
                : 'Waiting for the camera…'}
            </p>
          </div>
        )}
      </div>

      <div className={styles.controls}>
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

      {live.isLive && (
        <p className={styles.note}>
          {live.talking ? 'They can hear you.' : 'Hold the button to speak.'}
        </p>
      )}
    </div>
  );
}
