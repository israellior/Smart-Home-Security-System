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

/**
 * How long to wait for the doorbell to actually turn up before saying it
 * did not.
 *
 * A MINTED TOKEN IS NOT A CALL, and this constant is the whole of that
 * lesson. The server reports `deviceOnline: true` when it managed to write
 * the viewer-requested frame to a socket; it cannot report whether
 * anything read it. Between a doorbell losing power and the server's
 * heartbeat noticing, there is up to thirty seconds in which that write
 * succeeds into a socket with nobody on the other end - so a UI that
 * believes `deviceOnline` shows "Connecting..." forever for a doorbell
 * that is unplugged.
 *
 * Eighteen seconds is past the far end of a healthy start - the Pi has to
 * stop any recording, hand over the sound card, start webrtc-video.py, and
 * join the room - and short enough that a person has not yet decided the
 * app is broken.
 */
const ANSWER_TIMEOUT_MS = 18_000;

/**
 * What to tell someone whose microphone did not open.
 *
 * The browser's own wording is no help. WebKit's NotAllowedError says
 * "possibly because the user denied permission" to people who were never
 * asked, and the usual real cause on a phone is an in-app browser - a link
 * opened from Gmail, WhatsApp or the Google app - that has no microphone
 * permission to hand out.
 */
function micErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
      // The Google app's built-in browser (GSA in its user agent) refuses
      // without ever showing a prompt, so "allow it in your browser
      // settings" would send people looking for a setting the page never
      // offered them.
      if (/\bGSA\//.test(navigator.userAgent)) {
        return 'The Google app blocked the microphone. Open this page in Safari to talk, or turn on Microphone for Google in your iPhone Settings.';
      }
      return 'The microphone was blocked. Allow it for this site in your browser settings. If this page opened inside another app, open it in Safari or Chrome instead.';
    case 'NotFoundError':
      return 'No microphone was found on this device.';
    case 'NotReadableError':
      return 'The microphone is in use by another app.';
    default:
      return err?.message || 'The microphone could not be opened.';
  }
}

export function useLiveView(token, deviceId) {
  const [phase, setPhase] = useState(IDLE);
  const [error, setError] = useState(null);
  const [deviceOnline, setDeviceOnline] = useState(null);
  const [talking, setTalking] = useState(false);
  const [hasVideo, setHasVideo] = useState(false);
  // The doorbell was asked and did not turn up. Distinct from an error:
  // nothing failed, and pressing the button again is a reasonable thing to
  // do about it.
  const [unanswered, setUnanswered] = useState(false);

  const roomRef = useRef(null);
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const answerTimer = useRef(null);

  const detach = useCallback(() => {
    const room = roomRef.current;
    roomRef.current = null;
    if (room) room.disconnect().catch(() => {});
    clearTimeout(answerTimer.current);
    setPhase(IDLE);
    setTalking(false);
  // The open microphone while talking, and whether the button is still
  // held. Refs, because both are read after awaits that a release can
  // land in the middle of.
  const micTrack = useRef(null);
  const held = useRef(false);
    setHasVideo(false);
    setUnanswered(false);
  }, []);

    held.current = false;
    micTrack.current?.stop();
    micTrack.current = null;
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
    setUnanswered(false);
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

    // `hasVideo` keys on an actual video track, never on how many
    // participants are in the room, and that distinction is load-bearing.
    //
    // The Pi joins as TWO participants: `device:<id>:pub` publishes the
    // camera, and `device:<id>:sub` exists only to hear viewers and
    // publishes nothing, ever. Counting participants would see two and
    // conclude the camera had arrived - or see one and wait forever -
    // depending on which connected first.
    /*
     * What counts as the doorbell having answered.
     *
     * Either of two things: a video track arriving, or the publishing
     * participant appearing in the room. The track is the real answer and
     * the participant is the early one - it shows up a moment before its
     * first frame does, which is long enough to be worth not accusing a
     * working doorbell of being asleep.
     *
     * The identity comes from the server (`publisherIdentity`) rather than
     * being assembled here. Two copies of that string would drift, and the
     * symptom would be a live view that spins forever on a call that is
     * working perfectly.
     */
    const publisher = grant.publisherIdentity;

    const answered = () => {
      clearTimeout(answerTimer.current);
      setUnanswered(false);
    };

    // Re-armable, because the doorbell can also leave mid-call - a power
    // cut halfway through a conversation should go back to waiting and
    // then to "did not answer", not sit on a frozen last frame.
    const waitForAnswer = () => {
      clearTimeout(answerTimer.current);
      answerTimer.current = setTimeout(() => setUnanswered(true), ANSWER_TIMEOUT_MS);
    };

    room.on(RoomEvent.ParticipantConnected, (participant) => {
      if (participant.identity === publisher) answered();
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant.identity === publisher) waitForAnswer();
    });

    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Video && videoRef.current) {
        track.attach(videoRef.current);
        setHasVideo(true);
        answered();
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

    // Our own link wobbling is the third way the picture can stop, and it
    // deserves the same window as the other two rather than a frozen frame.
    room.on(RoomEvent.Reconnecting, waitForAnswer);

    room.on(RoomEvent.Disconnected, () => {
      roomRef.current = null;
      clearTimeout(answerTimer.current);
      setPhase(IDLE);
      setTalking(false);
      setHasVideo(false);
      setUnanswered(false);
    });

    try {
      await room.connect(grant.url, grant.token);
      setPhase(LIVE);

      // The doorbell may already be in the room - somebody else is
      // watching, or this viewer is joining a call in progress - in which
      // case no ParticipantConnected event is coming and the clock should
      // never start. Checked after connect, because the participant list
      // does not exist before it.
      const alreadyThere = [...room.remoteParticipants.values()].some(
        (p) => p.identity === publisher
      );
      if (alreadyThere) answered();
      else waitForAnswer();
    } catch (err) {
      roomRef.current = null;
      clearTimeout(answerTimer.current);
      setError(err.message);
      setPhase(ERROR);
    }
  }, [token, deviceId]);

  /**
   * Ask again. Cheap and idempotent on both sides - the server re-mints a
   * token and re-sends the cue, and the device treats a second
   * viewer-requested during a running call as a no-op - so this is a plain
   * teardown and restart rather than anything clever.
   */
  const retry = useCallback(async () => {
    detach();
    await start();
  }, [detach, start]);

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

    // Clear the last attempt's message, so a problem that has been fixed
    // stops being reported.
    setError(null);

    // getUserMedia exists only in a secure context. Served over plain
    // http from anything but localhost - a LAN address, say - there is
    // no microphone to open at all, while the video carries on working
    // perfectly, because *receiving* media carries no such restriction.
    // Checked here because the failure is otherwise indistinguishable
    // from the button being broken, and the exception the SDK throws
    // deeper down names none of this.
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        window.isSecureContext
          ? 'This browser will not give the page a microphone.'
          : `No microphone: ${window.location.origin} is not a secure origin. Reach the app over https, or on localhost.`
      );
      return;
    }

    try {
      micTrack.current = track;
      await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone });
      // Released during the publish: stopTalking stopped the track and
      // gave the floor back, but its unpublish raced this publish and may
      // have found nothing to take down.
      if (!held.current) {
        room.localParticipant.unpublishTrack(track).catch(() => {});
        return;
      }
      setTalking(true);
    } catch (err) {
      setError(err.message);
    }
  }, [phase, token, deviceId]);

  const stopTalking = useCallback(async () => {
    const room = roomRef.current;
    const track = micTrack.current;
    micTrack.current = null;
    // Unpublished and stopped rather than muted: a muted track still holds
    // the microphone open, and the phone's recording indicator stays on
    // for as long as the call does.
    if (track) {
      if (room) await room.localParticipant.unpublishTrack(track).catch(() => {});
      track.stop();
    }
    setTalking(false);
    await api.releaseTalk(token, deviceId).catch(() => {});
  }, [token, deviceId]);

  return {
    phase,
    error,
    deviceOnline,
    hasVideo,
    // True once the doorbell has had its window and not turned up. The UI
    // keys on this and on hasVideo, never on deviceOnline - which only ever
    // said a frame was written to a socket.
    unanswered,
    held.current = true;

    /*
     * The microphone is asked for before anything is awaited, so the
     * request happens while the press is still a press. Browsers that
     * gate the microphone on a user gesture see one; the floor request
     * runs alongside rather than in front, which also takes a network
     * round trip off the time to the first word.
     */
    const mic = navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    const floor = api.takeTalk(token, deviceId);
    const [micResult, floorResult] = await Promise.allSettled([mic, floor]);
    const track = micResult.value?.getAudioTracks()[0];

    // Whichever half succeeded is undone if the other did not, or if the
    // button was let go while both were in flight. Either one left behind
    // is a cost to somebody: a floor nobody can use locks everyone else
    // out, and a stray microphone is a microphone left open.
    const giveUp = () => {
      track?.stop();
      if (floorResult.status === 'fulfilled') api.releaseTalk(token, deviceId).catch(() => {});
      setTalking(false);
    };

    if (micResult.status === 'rejected' || floorResult.status === 'rejected') {
      giveUp();
      setError(
        micResult.status === 'rejected'
          ? micErrorMessage(micResult.reason)
          : floorResult.reason.message
      );
      return;
    }
    if (!held.current || roomRef.current !== room) return giveUp();

    talking,
    videoRef,
    audioRef,
    start,
    retry,
      micTrack.current = null;
      giveUp();
    stop,
    startTalking,
    stopTalking,
    isIdle: phase === IDLE,
    isConnecting: phase === CONNECTING,
    isLive: phase === LIVE
  };
}
    held.current = false;
