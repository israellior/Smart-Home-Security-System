const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

async function request(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  // 204 No Content (delete, leave) has no body to parse.
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));

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
  me: (token) => request('/auth/me', { token }),

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

  listEvents: (token, deviceId) => request(`/devices/${deviceId}/events`, { token }),

  // Fetched when someone presses play, not with the list. Playback URLs
  // are short-lived by design, so ones handed out with a list loaded ten
  // minutes ago would already have expired.
  getClipUrl: (token, deviceId, eventId) =>
    request(`/devices/${deviceId}/events/${encodeURIComponent(eventId)}/clip`, { token }),

  // Asking for this token is also what nudges the doorbell to stop
  // recording and join the room, so it is a POST rather than a GET - it
  // has an effect beyond handing something back.
  startLive: (token, deviceId) => request(`/devices/${deviceId}/live`, { method: 'POST', token }),

  takeTalk: (token, deviceId) => request(`/devices/${deviceId}/talk`, { method: 'POST', token }),
  releaseTalk: (token, deviceId) => request(`/devices/${deviceId}/talk`, { method: 'DELETE', token })
};
