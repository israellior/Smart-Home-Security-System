import { useEffect, useState } from 'react';
import { signalUrl, backoffDelay, CLOSE_UNAUTHORIZED } from '../api/signal';

/**
 * One live connection to one doorbell.
 *
 * Returns whether the hardware is on the other end right now, and the
 * most recent event pushed to us. Callers merge `lastEvent` into their
 * own list rather than being handed a callback, because a callback
 * captured at connect time goes stale the moment the component
 * re-renders - and the fix for that (a ref) is the same amount of code in
 * every caller instead of none.
 *
 * `connected` is null until the socket says otherwise, so a caller can
 * tell "not connected" from "we don't know yet" and avoid flashing the
 * wrong status on load.
 */
export function useDeviceSignal(token, deviceId) {
  const [connected, setConnected] = useState(null);
  const [lastEvent, setLastEvent] = useState(null);
  // A clip that finished uploading, kept apart from lastEvent on purpose:
  // it fills in an alert that is already listed, and anything counting
  // unread events off lastEvent must not count it as a new one.
  const [lastClip, setLastClip] = useState(null);
  // A row somebody saved or unsaved - the whole event as it now stands.
  // Apart from lastEvent for the same reason as lastClip: it is not news.
  const [lastSaved, setLastSaved] = useState(null);
  // Who is recording the live view, `{ userId, name }` or null. Pushed on
  // every change, so only one person is ever offered the Rec button.
  const [recorder, setRecorder] = useState(null);
  // Whose voice is coming out of the doorbell - a user id, or null.
  const [talker, setTalker] = useState(null);
  // The doorbell's Wi-Fi signal in dBm, as it last reported it. Null when
  // it has not said, is not on Wi-Fi, or is not connected at all.
  const [rssi, setRssi] = useState(null);

  useEffect(() => {
    if (!token || !deviceId) return undefined;

    // Cleared on every (re)subscribe, so switching doorbells cannot carry
    // the previous one's last event or presence across. Without this,
    // navigating from a connected doorbell to a disconnected one would
    // show the new one as connected until its socket disagreed.
    setConnected(null);
    setLastEvent(null);
    setLastClip(null);
    setLastSaved(null);
    setRecorder(null);
    setTalker(null);
    setRssi(null);

    let socket = null;
    let retryTimer = null;
    let attempt = 0;
    let abandoned = false;

    function open() {
      socket = new WebSocket(signalUrl());

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'hello', role: 'browser', deviceId, token }));
      };

      socket.onmessage = (message) => {
        let frame;
        try {
          frame = JSON.parse(message.data);
        } catch (err) {
          return;
        }

        switch (frame.type) {
          case 'hello-ok':
            // Only now is the connection actually usable, so the backoff
            // resets here rather than in onopen: a socket that opens and
            // is immediately rejected has not succeeded at anything, and
            // resetting there would retry it at full speed forever.
            attempt = 0;
            setConnected(Boolean(frame.connected));
            setRecorder(frame.recorder ?? null);
            setTalker(frame.talker ?? null);
            setRssi(frame.rssi ?? null);
            break;
          case 'presence':
            setConnected(Boolean(frame.connected));
            // The signal belonged to the connection that just went. A
            // doorbell coming back reports it again within moments.
            if (!frame.connected) setRssi(null);
            break;
          case 'link':
            setRssi(frame.rssi ?? null);
            break;
          case 'talk-floor':
            setTalker(frame.userId ?? null);
            break;
          case 'event':
            setLastEvent(frame.event);
            break;
          case 'clip':
            setLastClip({ eventId: frame.eventId, clip: frame.clip });
            break;
          case 'event-saved':
            setLastSaved(frame.event);
            break;
          case 'record-floor':
            setRecorder(frame.recorder ?? null);
            break;
          default:
            break;
        }
      };

      socket.onclose = (closeEvent) => {
        setConnected(null);
        setRssi(null);
        if (abandoned) return;

        // A rejected credential is a permanent answer - the same rule the
        // device side follows. Reconnecting cannot make it true, so this
        // stops rather than looping.
        if (closeEvent.code === CLOSE_UNAUTHORIZED) return;

        retryTimer = setTimeout(open, backoffDelay(attempt));
        attempt += 1;
      };

      // Without this the browser logs an uncaught error for what is a
      // routine event - a server restart, a laptop lid closing. onclose
      // follows and does the actual recovery.
      socket.onerror = () => {};
    }

    open();

    return () => {
      abandoned = true;
      clearTimeout(retryTimer);
      // 1000 = a normal closure. Anything else and the server would treat
      // a page navigation as an abnormal drop.
      if (socket && socket.readyState <= WebSocket.OPEN) socket.close(1000, 'Navigated away');
    };
  }, [token, deviceId]);

  return { connected, lastEvent, lastClip, lastSaved, recorder, talker, rssi };
}
