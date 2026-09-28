import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDevice } from '../components/DeviceLayout';
import { useDevices } from '../context/DevicesContext';
import { GlowIcon } from '../components/GlowIcon';
import {
  deviceStatus,
  isAwaitingFirstContact,
  statusDetail,
  statusTone
} from '../lib/deviceStatus';
import styles from './DeviceOverview.module.css';

/**
 * Split out, because the LiveKit client is roughly three times the size
 * of the entire rest of this app. Bundled inline it would be downloaded
 * by everyone opening any page, to serve the one thing they may never
 * press. Loaded this way it arrives with the component that needs it.
 */
const LiveView = lazy(() =>
  import('../components/LiveView').then((m) => ({ default: m.LiveView }))
);

/**
 * One doorbell's headline view - what Home used to be, back when there
 * was only ever one. The device comes from DeviceLayout via the router's
 * outlet context, so this page never fetches or looks anything up.
 */
// How often to re-ask while a brand new doorbell is being set up. Five
// seconds is chosen against what the customer is doing: standing by the
// door with a phone, having just typed a wi-fi password into it.
const FIRST_CONTACT_POLL_MS = 5000;

export function DeviceOverview() {
  const device = useDevice();
  const { refresh } = useDevices();

  // Already live-aware: DeviceLayout folds the socket's presence in before
  // this page ever sees the device.
  const status = deviceStatus(device);
  const awaitingFirstContact = isAwaitingFirstContact(status);

  /*
   * The one screen in the app that polls, and only while a doorbell has
   * never reported in.
   *
   * The moment being waited for does not arrive over the socket. The setup
   * service's last check before it declares success is an HTTPS call -
   * `GET /api/devices/<id>/self` with the device credential - and that
   * lands *seconds before* the daemon's signaling socket comes up. So the
   * server learns a doorbell exists on the network well before anything
   * can push that to this page, and "waiting for your doorbell" would sit
   * there for the whole of setup with the answer already in the database.
   *
   * It stops on its own: once first contact is recorded the status is no
   * longer never-connected, this effect tears down, and presence goes back
   * to being the socket's job.
   */
  useEffect(() => {
    if (!awaitingFirstContact) return undefined;
    const timer = setInterval(refresh, FIRST_CONTACT_POLL_MS);
    return () => clearInterval(timer);
  }, [awaitingFirstContact, refresh]);

  // Whether the live view is filling the screen. Owned here rather than
  // inside LiveView because the ring that opens it lives on this page,
  // above the point where LiveView is even loaded.
  const [expanded, setExpanded] = useState(false);

  // Stable, so the Escape-key listener in LiveView isn't torn down and
  // rebuilt on every render of this page.
  const ringRef = useRef(null);
  const collapse = useCallback(() => {
    setExpanded(false);
    // Put the keyboard back where it came from. The close button it was
    // on is about to stop existing, and focus would otherwise fall to
    // the top of the document.
    ringRef.current?.focus();
  }, []);

  /*
   * The ring is the way into the full screen view, so it is a button
   * only when there is something to open. A doorbell with no hardware
   * paired has no camera, and a control that looks pressable and does
   * nothing is worse than one that plainly isn't.
   */
  const ring = device.provisioned ? (
    <button
      ref={ringRef}
      type="button"
      className={styles.glowRing}
      onClick={() => setExpanded(true)}
      aria-label={`Watch ${device.name} live, full screen`}
    >
      <GlowIcon />
    </button>
  ) : (
    <div className={styles.glowRing}>
      <GlowIcon />
    </div>
  );

  return (
    <section>
      <div className={styles.hero}>
        {ring}
        <p className={styles.deviceName}>{device.name}</p>
        <p className={`${styles.deviceState} ${styles[statusTone(status)]}`}>
          {statusDetail(status)}
        </p>
        {device.location && <p className={styles.deviceLocation}>{device.location}</p>}

        {device.provisioned ? (
          <>
            <Suspense fallback={<p className={styles.heroNote}>Loading live view…</p>}>
              <LiveView device={device} expanded={expanded} onCollapse={collapse} />
            </Suspense>
            {/* Said here rather than only in the status line, because this
                is the state a customer spends the whole of setup in and
                "never connected" on its own reads like a fault. It is
                also the state where the useful next step is not in this
                app at all - it is the setup page on the doorbell's own
                wi-fi network. */}
            {awaitingFirstContact && (
              <p className={styles.heroNote}>
                This doorbell has its credential but hasn&apos;t reached us yet. Give it power,
                then join <strong>its own wi-fi network</strong> — the name and password are on
                the sticker — and hand it your home network. This page updates on its own.
              </p>
            )}
          </>
        ) : (
          <>
            <button className={styles.liveBtn} disabled>
              View live
            </button>
            <p className={styles.heroNote}>
              This doorbell has no hardware paired with it yet. Live video and two-way talk turn
              on once a camera is set up and connected.
            </p>
          </>
        )}
      </div>

      <p className={styles.sectionLabel}>Get started</p>
      <Link className={styles.settingsLink} to={`/devices/${device._id}/settings`}>
        Set up this doorbell
      </Link>
    </section>
  );
}
