const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

/**
 * The signaling socket shares the API's origin and port - one host, one
 * deployment, no second CORS story - so its URL is derived from the API
 * URL rather than configured separately. Two settings that must agree is
 * two settings that eventually won't.
 */
export function signalUrl() {
  const url = new URL(API_URL, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/api\/?$/, '')}/signal`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

// The server's private close codes. 4002 means the credential was
// rejected, which reconnecting cannot fix - retrying it just produces a
// loop that hammers the server and never succeeds.
export const CLOSE_UNAUTHORIZED = 4002;
export const CLOSE_REPLACED = 4001;

// Exponential with a ceiling and jitter. The jitter matters more than it
// looks: without it every browser that was watching when the server
// restarted reconnects in the same instant, which is the moment the
// server can least afford it.
export function backoffDelay(attempt) {
  const base = Math.min(30000, 1000 * 2 ** attempt);
  return base * (0.5 + Math.random() * 0.5);
}
