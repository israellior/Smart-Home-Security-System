const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

export const SESSION_ENDED = 'porchlight:session-ended';

// `blob` sends a file as the body, typed as itself, instead of JSON - the
// face photos, which the server takes as raw image/jpeg.
async function request(path, { method = 'GET', body, blob, token } = {}) {
  const headers = { 'Content-Type': blob ? blob.type : 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: blob ?? (body ? JSON.stringify(body) : undefined)
  });

  // 204 No Content (delete, leave) has no body to parse.
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));

  // A 401 on a request that carried a token means the session is over -
  // expired, or ended by "sign out everywhere" on another device. Said
  // once, here, so AuthContext can sign this tab out instead of every
  // page showing its own error against a session that will never work
  // again. A 401 without a token is a wrong password, and stays local.
  // The token rides along so a slow request from an old session cannot
  // sign out the new one.
  if (res.status === 401 && token) {
    window.dispatchEvent(new CustomEvent(SESSION_ENDED, { detail: { token } }));
  }

  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    // Callers need to tell these apart - a 403 on "delete this doorbell"
    // means "you're only a member", a 404 means "it's gone", and a 409
    // means "you're the owner, delete it instead". Throwing a bare
    // Error lost that distinction.
    err.status = res.status;
    throw err;
  }
  return data;
}

// Thin, explicit wrapper around every backend endpoint the frontend
// uses. Keeping every fetch call in one file means the URL shape and
// error handling only live in one place - a new page never needs to
// know the API base URL or repeat the try/catch-and-parse dance.
export const api = {
  register: (payload) => request('/auth/register', { method: 'POST', body: payload }),
  login: (payload) => request('/auth/login', { method: 'POST', body: payload }),
  // Answers the same whether or not the address has an account.
  forgotPassword: (email) =>
    request('/auth/forgot-password', { method: 'POST', body: { email } }),
  resetPassword: (payload) => request('/auth/reset-password', { method: 'POST', body: payload }),
  me: (token) => request('/auth/me', { token }),
  signOutEverywhere: (token) =>
    request('/auth/sign-out-everywhere', { method: 'POST', token }),
  // A wrong password on these two answers 403, never 401 - a 401 here
  // would read as "session over" and sign this tab out (see request()).
  updateMe: (token, fields) => request('/auth/me', { method: 'PATCH', body: fields, token }),
  changePassword: (token, payload) =>
    request('/auth/change-password', { method: 'POST', body: payload, token }),
  deleteAccount: (token, password) =>
    request('/auth/me', { method: 'DELETE', body: { password }, token }),

  // Web Push. The key is public and needs no login. A subscription is
  // this browser's, keyed on its endpoint; PUT again whenever it might
  // have changed. The test goes to this browser only.
  getPushKey: () => request('/push/key'),
  savePushSubscription: (token, subscription) =>
    request('/push/subscriptions', { method: 'PUT', body: subscription, token }),
  deletePushSubscription: (token, endpoint) =>
    request('/push/subscriptions', { method: 'DELETE', body: { endpoint }, token }),
  sendTestPush: (token, endpoint) =>
    request('/push/test', { method: 'POST', body: { endpoint }, token }),

  listDevices: (token) => request('/devices', { token }),
  getDevice: (token, id) => request(`/devices/${id}`, { token }),
  createDevice: (token, payload) => request('/devices', { method: 'POST', body: payload, token }),
  // The two codes, and they are not interchangeable. /claim takes the
  // one-time code on a new unit and makes you its owner; /join takes a
  // code an owner generated in the app and makes you a member. The server
  // keeps them apart for a reason - see utils/claimCode.js there - so the
  // client does too, rather than posting to one endpoint with a flag.
  claimDevice: (token, claimCode) =>
    request('/devices/claim', { method: 'POST', body: { claimCode }, token }),
  joinDevice: (token, shareCode) =>
    request('/devices/join', { method: 'POST', body: { shareCode }, token }),
  updateDevice: (token, id, patch) =>
    request(`/devices/${id}`, { method: 'PATCH', body: patch, token }),
  // Notification preferences are yours alone, so they write your
  // membership rather than the shared device.
  updatePreferences: (token, id, prefs) =>
    request(`/devices/${id}/preferences`, { method: 'PATCH', body: prefs, token }),
  markSeen: (token, id) => request(`/devices/${id}/seen`, { method: 'POST', token }),
  deleteDevice: (token, id) => request(`/devices/${id}`, { method: 'DELETE', token }),

  // Share codes are made and unmade on demand now, rather than existing
  // from the moment a doorbell does. Calling create again rotates the
  // code, which is how an owner locks out somebody who has the old one.
  createShareCode: (token, id) =>
    request(`/devices/${id}/share-code`, { method: 'POST', token }),
  revokeShareCode: (token, id) =>
    request(`/devices/${id}/share-code`, { method: 'DELETE', token }),

  listMembers: (token, id) => request(`/devices/${id}/members`, { token }),
  removeMember: (token, id, userId) =>
    request(`/devices/${id}/members/${userId}`, { method: 'DELETE', token }),

  // `filter` is one of ring, motion, live, saved - or nothing, for all.
  // `before` is the nextCursor of the page already shown.
  listEvents: (token, deviceId, { filter, before } = {}) => {
    const query = new URLSearchParams();
    if (filter && filter !== 'all') query.set('filter', filter);
    if (before) query.set('before', before);
    const qs = query.toString();
    return request(`/devices/${deviceId}/events${qs ? `?${qs}` : ''}`, { token });
  },

  // Software: the release the doorbells are being brought to, and asking
  // one to install it now instead of tonight.
  getLatestRelease: (token) => request('/releases/latest', { token }),
  requestUpdate: (token, deviceId) =>
    request(`/devices/${deviceId}/update`, { method: 'POST', token }),

  // Wi-Fi. Both answer at once and report on the socket: the networks the
  // doorbell sees as `wifi-networks`, and the move as `wifi-status`.
  scanWifi: (token, deviceId) =>
    request(`/devices/${deviceId}/wifi/scan`, { method: 'POST', token }),
  joinWifi: (token, deviceId, ssid, psk) =>
    request(`/devices/${deviceId}/wifi`, { method: 'POST', body: { ssid, psk }, token }),

  // The people a doorbell knows by face. Any member sees the list; only the
  // owner adds, renames or removes anyone. A photo is one cropped face as a
  // JPEG - the doorbell turns it into its own codes, and answers on the
  // socket as `faces-changed` once it has.
  listPeople: (token, deviceId) => request(`/devices/${deviceId}/faces`, { token }),
  createPerson: (token, deviceId, name) =>
    request(`/devices/${deviceId}/faces`, { method: 'POST', body: { name }, token }),
  renamePerson: (token, deviceId, personId, name) =>
    request(`/devices/${deviceId}/faces/${personId}`, { method: 'PATCH', body: { name }, token }),
  deletePerson: (token, deviceId, personId) =>
    request(`/devices/${deviceId}/faces/${personId}`, { method: 'DELETE', token }),
  addFacePhoto: (token, deviceId, personId, jpeg) =>
    request(`/devices/${deviceId}/faces/${personId}/photos`, { method: 'POST', blob: jpeg, token }),

  // Kept past the week for everyone on the doorbell, or not. Both answer
  // with the event as it now stands.
  saveEvent: (token, deviceId, eventId) =>
    request(`/devices/${deviceId}/events/${encodeURIComponent(eventId)}/saved`, {
      method: 'PUT',
      token
    }),
  unsaveEvent: (token, deviceId, eventId) =>
    request(`/devices/${deviceId}/events/${encodeURIComponent(eventId)}/saved`, {
      method: 'DELETE',
      token
    }),

  // Fetched when someone presses play, not with the list. Playback URLs
  // are short-lived by design, so ones handed out with a list loaded ten
  // minutes ago would already have expired.
  getClipUrl: (token, deviceId, eventId) =>
    request(`/devices/${deviceId}/events/${encodeURIComponent(eventId)}/clip`, { token }),

  // Asking for this token is also what nudges the doorbell to stop
  // recording and join the room, so it is a POST rather than a GET - it
  // has an effect beyond handing something back.
  startLive: (token, deviceId) => request(`/devices/${deviceId}/live`, { method: 'POST', token }),

  // A recording from the live view: ask for somewhere to put it (sized to
  // the finished file), PUT it straight to the bucket, then confirm. The
  // PUT is not here - it goes to the bucket, not to us - see
  // useLiveRecording.
  // The turn to record - one member at a time, first press holds it. A 409
  // names whoever has it.
  takeRecording: (token, deviceId) =>
    request(`/devices/${deviceId}/record`, { method: 'POST', token }),
  releaseRecording: (token, deviceId) =>
    request(`/devices/${deviceId}/record`, { method: 'DELETE', token }),
  startRecording: (token, deviceId, { bytes, durationMs }) =>
    request(`/devices/${deviceId}/recordings`, {
      method: 'POST',
      body: { bytes, durationMs },
      token
    }),
  confirmRecording: (token, deviceId, eventId) =>
    request(`/devices/${deviceId}/recordings/${encodeURIComponent(eventId)}/confirm`, {
      method: 'POST',
      token
    }),

  // `identity` is this tab's participant in the call. The floor goes to a
  // session rather than a person, because the same person can be watching
  // on two screens and only the one being pressed should open a microphone.
  takeTalk: (token, deviceId, identity) =>
    request(`/devices/${deviceId}/talk`, { method: 'POST', body: { identity }, token }),
  releaseTalk: (token, deviceId, identity) =>
    request(`/devices/${deviceId}/talk`, { method: 'DELETE', body: { identity }, token })
};
