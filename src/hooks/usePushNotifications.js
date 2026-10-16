import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import {
  pushState,
  pushSupport,
  registerServiceWorker,
  subscribe,
  syncSubscription,
  unsubscribe
} from '../lib/push';

/**
 * This browser's notification switch, for Settings.
 *
 * `status` is one of:
 *   'loading'        still asking the browser
 *   'install-first'  iPhone/iPad in Safari - add to Home Screen first
 *   'unsupported'    no Web Push in this browser
 *   'blocked'        the person said no; only browser settings can undo it
 *   'off'            can be turned on
 *   'on'             subscribed, and the server has it
 */
export function usePushNotifications() {
  const { token } = useAuth();
  const [status, setStatus] = useState('loading');
  const [endpoint, setEndpoint] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const refresh = useCallback(async () => {
    const support = pushSupport();
    if (support !== 'supported') {
      setStatus(support);
      return;
    }
    const state = await pushState();
    setEndpoint(state.endpoint);
    if (state.permission === 'denied') setStatus('blocked');
    else setStatus(state.endpoint && state.permission === 'granted' ? 'on' : 'off');
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (work) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const enable = () => run(() => subscribe(token));
  const disable = () => run(() => unsubscribe(token));
  const sendTest = () =>
    run(async () => {
      await api.sendTestPush(token, endpoint);
      setMessage({ tone: 'ok', text: 'Sent. It should appear in a few seconds.' });
    });

  return { status, busy, message, enable, disable, sendTest };
}

/**
 * Runs once per signed-in session, from the app shell: registers the
 * service worker and re-sends this browser's subscription if it has one.
 * See syncSubscription for why that matters.
 */
export function usePushSync() {
  const { token } = useAuth();
  useEffect(() => {
    if (!token) return;
    registerServiceWorker().then(() => syncSubscription(token));
  }, [token]);
}

/**
 * A tapped notification while the app is already open arrives here from
 * the service worker, and moves through the router instead of reloading.
 */
export function usePushNavigation() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    const onMessage = (event) => {
      if (event.data?.type === 'porchlight:open' && typeof event.data.url === 'string') {
        // Paths only. Anything else is not ours to follow.
        if (event.data.url.startsWith('/') && !event.data.url.startsWith('//')) navigate(event.data.url);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);
}
