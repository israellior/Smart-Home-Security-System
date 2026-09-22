import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { api } from '../api/client';

/**
 * One live connection to one doorbell's camera and microphone.
 *
 * The app server is never in the media path - it hands out a token and
 * the browser connects to LiveKit directly. So this hook owns the Room
 * object, and the token is only used to get in: once connected, the
 * session outlives the two-minute token.
 *
 * Returns a ref to attach to a <video>, the connection phase, and a
 * push-to-talk pair. Nothing starts until start() is called, because
 * opening a camera feed is a decision, not a side effect of visiting a
 * page.
 */

const IDLE = 'idle';
const CONNECTING = 'connecting';
const LIVE = 'live';
const ERROR = 'error';

export function useLiveView(token, deviceId) {
  const [phase, setPhase] = useState(IDLE);
  const [error, setError] = useState(null);
  const [deviceOnline, setDeviceOnline] = useState(null);
  const [talking, setTalking] = useState(false);
  const [hasVideo, setHasVideo] = useState(false);

  const roomRef = useRef(null);
  const videoRef = useRef(null);
  const audioRef = useRef(null);

  const detach = useCallback(() => {
    const room = roomRef.current;
    roomRef.current = null;
    if (room) room.disconnect().catch(() => {});
    setPhase(IDLE);
    setTalking(false);
    setHasVideo(false);
  }, []);

  // Leaving the page must close the connection. Without this the room
  // stays joined in the background - the doorbell goes on publishing to
  // a viewer who walked away, and the Pi has no way to know.
  useEffect(() => detach, [detach]);

  // Switching doorbells tears down the previous one for the same reason.
  useEffect(() => {
    detach();
  }, [deviceId, detach]);

  const start = useCallback(async () => {
    setError(null);
    setPhase(CONNECTING);

    let grant;
    try {
      grant = await api.startLive(token, deviceId);
    } catch (err) {
      setError(err.message);
      setPhase(ERROR);
      return;
    }

    setDeviceOnline(grant.deviceOnline);

    // adaptiveStream drops resolution when the <video> is small or
    // hidden, and dynacast stops the Pi sending layers nobody is
    // watching. Both matter more here than in a typical call: the
    // publisher is a Raspberry Pi with one uplink.
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Video && videoRef.current) {
        track.attach(videoRef.current);
        setHasVideo(true);
      }
      // Audio is attached to its own element rather than the video one,
      // so the doorbell keeps being audible even before any video
      // arrives - hearing someone is the part that matters at a door.
      if (track.kind === Track.Kind.Audio && audioRef.current) track.attach(audioRef.current);
    });

    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach();
      if (track.kind === Track.Kind.Video) setHasVideo(false);
    });

    room.on(RoomEvent.Disconnected, () => {
      roomRef.current = null;
      setPhase(IDLE);
      setTalking(false);
      setHasVideo(false);
    });

    try {
      await room.connect(grant.url, grant.token);
      setPhase(LIVE);
    } catch (err) {
      roomRef.current = null;
      setError(err.message);
      setPhase(ERROR);
    }
  }, [token, deviceId]);

  const stop = useCallback(async () => {
    // Give the floor back before leaving. The server would time it out
    // anyway, but a minute of nobody being able to talk because someone
    // closed a tab is a minute too long.
    if (talking) await api.releaseTalk(token, deviceId).catch(() => {});
    detach();
  }, [talking, token, deviceId, detach]);

  /**
   * Push to talk. The server grants publish rights on the session that
   * is already up, so this does not reconnect - but the microphone
   * itself still has to be enabled locally, and the browser may prompt
   * for permission the first time.
   */
  const startTalking = useCallback(async () => {
    const room = roomRef.current;
    if (!room || phase !== LIVE) return;
    try {
      await api.takeTalk(token, deviceId);
      await room.localParticipant.setMicrophoneEnabled(true);
      setTalking(true);
    } catch (err) {
      setError(err.message);
      // Hand the floor back rather than holding one we cannot use - a
      // denied microphone would otherwise lock everyone else out.
      api.releaseTalk(token, deviceId).catch(() => {});
      setTalking(false);
    }
  }, [phase, token, deviceId]);

  const stopTalking = useCallback(async () => {
    const room = roomRef.current;
    if (room) await room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
    setTalking(false);
    await api.releaseTalk(token, deviceId).catch(() => {});
  }, [token, deviceId]);

  return {
    phase,
    error,
    deviceOnline,
    hasVideo,
    talking,
    videoRef,
    audioRef,
    start,
    stop,
    startTalking,
    stopTalking,
    isIdle: phase === IDLE,
    isConnecting: phase === CONNECTING,
    isLive: phase === LIVE
  };
}
