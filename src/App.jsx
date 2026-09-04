import { Routes, Route, Outlet } from 'react-router-dom';
import { Header } from './components/Header';
import { TabNav } from './components/TabNav';
import { ProtectedRoute } from './components/ProtectedRoute';
import { SettingsProvider } from './context/SettingsContext';
import { Home } from './pages/Home';
import { Activity } from './pages/Activity';
import { Settings } from './pages/Settings';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import styles from './App.module.css';

/**
 * Chrome (Header + TabNav) shared by every logged-in page. Wrapped in
 * SettingsProvider here (rather than globally) because settings are
 * fetched from the API using the auth token - there's nothing to load
 * until we already know the visitor is logged in.
 */
function AppShell() {
  return (
    <SettingsProvider>
      <div className={styles.shell}>
        <Header />
        <TabNav />
        <main className={styles.main}>
          <Outlet />
        </main>
      </div>
    </SettingsProvider>
  );
}

/**
 * Route table. /login and /register are public and have no Header/TabNav.
 * Everything else sits behind <ProtectedRoute>, which redirects to /login
 * if there's no valid session.
 *
 * To add a new logged-in page later:
 *   1. create src/pages/NewPage.jsx (+ .module.css)
 *   2. add a <Route> inside the AppShell block below
 *   3. add an entry to TABS in components/TabNav.jsx
 */
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<Home />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Route>
    </Routes>
  );
}
