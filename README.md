# Porchlight

React + Vite frontend for the doorbell app, talking to the
[Porchlight API](../porchlight-backend) for accounts, settings, and
activity events.

## Running it

**The backend must be running first** - see `../porchlight-backend/README.md`
for MongoDB setup. Once that's up on `http://localhost:4000`:

```
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173). You'll
land on `/login` since there's no session yet - use "Create one" to
register an account, which also logs you in and creates your first
device with default settings.

If your backend runs somewhere other than `localhost:4000`, copy
`.env.example` to `.env.local` and set `VITE_API_URL` accordingly.

To build a static production bundle:

```
npm run build
```

Output goes to `dist/`, which you can serve from any static host.

## Structure

```
src/
  main.jsx              - app entry point, wraps everything in providers + router
  App.jsx                - route table: public auth pages + protected app shell
  index.css              - design tokens (colors, fonts) shared by every component

  api/
    client.js             - every fetch call to the backend lives here

  context/
    ThemeContext.jsx      - light/dark ("day porch" / "evening porch") state, local-only
    AuthContext.jsx        - JWT + current user, backed by the API
    SettingsContext.jsx    - device settings, fetched from/saved to the API

  hooks/
    useLocalStorage.js    - generic localStorage-backed useState (used by ThemeContext)

  components/             - small reusable pieces used across pages
    Header.jsx
    TabNav.jsx
    ProtectedRoute.jsx     - redirects to /login if there's no valid session
    Toggle.jsx             - on/off switch
    SegmentedControl.jsx   - Low/Standard/High-style picker
    GlowIcon.jsx

  pages/                  - one file per route
    Login.jsx
    Register.jsx
    Home.jsx
    Activity.jsx
    Settings.jsx
```

Each page and each component has a matching `.module.css` file
(CSS Modules), so styles are scoped and won't leak between pages -
you can freely add a `.hero` class to a brand new page without
worrying about it colliding with Home's `.hero`.

## Adding a new page

1. Create `src/pages/NewPage.jsx` and `NewPage.module.css`.
2. Add a `<Route path="/new-page" element={<NewPage />} />` in `App.jsx`.
3. Add `{ to: '/new-page', label: 'New Page' }` to the `TABS` array in
   `components/TabNav.jsx`.

## Where the real device will plug in

- `pages/Activity.jsx` shows real events fetched from the API once
  there are any; `PREVIEW_EVENTS` is only shown as a labeled preview
  when a device has none yet, so new accounts aren't just a blank page.
- `Header.jsx` reads `settings.connected` (a real field on the `Device`
  model in the backend, currently always `false` since nothing sets it
  yet). Once the WebRTC/signaling layer exists, that's the flag that
  should flip to `true`.
- The "View live — coming soon" button on Home (`pages/Home.jsx`) is
  where the live video player will eventually go.
