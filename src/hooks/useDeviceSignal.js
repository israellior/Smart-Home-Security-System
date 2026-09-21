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

  useEffect(() => {
    if (!token || !deviceId) return undefined;

    // Cleared on every (re)subscribe, so switching doorbells cannot carry
    // the previous one's last event or presence across. Without this,
    // navigating from a connected doorbell to a disconnected one would
    // show the new one as connected until its socket disagreed.
    setConnected(null);
    setLastEvent(null);

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
            break;
          case 'presence':
            setConnected(Boolean(frame.connected));
            break;
          case 'event':
            setLastEvent(frame.event);
            break;
          default:
            break;
        }
      };

      socket.onclose = (closeEvent) => {
        setConnected(null);
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

  return { connected, lastEvent };
}
