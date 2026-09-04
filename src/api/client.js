const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

async function request(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
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
  createDevice: (token, payload) => request('/devices', { method: 'POST', body: payload, token }),
  updateDevice: (token, id, patch) =>
    request(`/devices/${id}`, { method: 'PATCH', body: patch, token }),

  listEvents: (token, deviceId) => request(`/devices/${deviceId}/events`, { token })
};
