import { Routes, Route, Outlet } from 'react-router-dom';
import { Header } from './components/Header';
import { ProtectedRoute } from './components/ProtectedRoute';
import { GuestRoute } from './components/GuestRoute';
import { DeviceLayout } from './components/DeviceLayout';
import { DevicesProvider } from './context/DevicesContext';
import { usePushNavigation, usePushSync } from './hooks/usePushNotifications';
import { Home } from './pages/Home';
import { AddDevice } from './pages/AddDevice';
import { DeviceOverview } from './pages/DeviceOverview';
import { Activity } from './pages/Activity';
import { Settings } from './pages/Settings';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { ForgotPassword } from './pages/ForgotPassword';
import { ResetPassword } from './pages/ResetPassword';
import styles from './App.module.css';

/**
 * Chrome shared by every logged-in page. Wrapped in DevicesProvider here
 * (rather than globally) because the device list is fetched from the API
 * using the auth token - there's nothing to load until we already know
 * the visitor is logged in.
 *
 * The tab bar is no longer here: tabs belong to one doorbell, and this
 * shell also renders the list of them.
 */
function AppShell() {
  usePushSync();

  return (
    <DevicesProvider>
      <div className={styles.shell}>
        <Header />
        <main className={styles.main}>
          <Outlet />
        </main>
      </div>
    </DevicesProvider>
  );
}

/**
 * Route table. The logged-out pages have no chrome of their own - they
 * share AuthLayout instead. /login, /register and /forgot-password sit
 * behind <GuestRoute>, which moves a signed-in visitor on. Everything
 * else sits behind <ProtectedRoute>, which redirects to /login if there's
 * no valid session.
 *
 *   /reset-password          the link from a reset email; outside both,
 *                            because it has to work whether or not this
 *                            browser is signed in
 *
 *   /                        the list of your doorbells
 *   /devices/new             create one, or join with a share code
 *   /devices/:deviceId       one doorbell, via DeviceLayout:
 *     .                        overview
 *     ./activity               its motion/ring events
 *     ./settings               its settings + who has access
 *
 * To add a new per-device view later:
 *   1. create src/pages/NewView.jsx (+ .module.css)
 *   2. add a <Route> inside the DeviceLayout block below
 *   3. add an entry to the tabs array in components/TabNav.jsx
 */
export function App() {
  usePushNavigation();

  return (
    <Routes>
      <Route element={<GuestRoute />}>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
      </Route>
      <Route path="/reset-password" element={<ResetPassword />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<Home />} />
          <Route path="/devices/new" element={<AddDevice />} />

          <Route element={<DeviceLayout />}>
            <Route path="/devices/:deviceId" element={<DeviceOverview />} />
            <Route path="/devices/:deviceId/activity" element={<Activity />} />
            <Route path="/devices/:deviceId/settings" element={<Settings />} />
          </Route>
        </Route>
      </Route>
    </Routes>
  );
}
