import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useDevices } from '../context/DevicesContext';
import { SegmentedControl } from '../components/SegmentedControl';
import styles from './AddDevice.module.css';

const MODES = [
  { value: 'create', label: 'Set up new' },
  { value: 'join', label: 'Use a code' }
];

/**
 * Two ways to get a doorbell onto your list: create one you'll own, or
 * join one someone else owns with the code they give you. Same
 * destination either way, so they share a form rather than sitting on
 * two pages.
 */
export function AddDevice() {
  const { devices, addDevice, joinDevice } = useDevices();
  const navigate = useNavigate();

  // A name that isn't already on the list. Submitting this form with the
  // name blank used to fall back to the constant 'Front Door', so adding
  // several doorbells in a row produced rows that were genuinely
  // different records but looked identical - same name, same status, no
  // way to tell which was which. Showing this as the placeholder also
  // makes the default honest: what you see is what it will be called.
  const suggestedName = useMemo(() => {
    const taken = new Set(devices.map((d) => d.name));
    if (!taken.has('Front Door')) return 'Front Door';
    let n = 2;
    while (taken.has(`Front Door ${n}`)) n++;
    return `Front Door ${n}`;
  }, [devices]);

  const [mode, setMode] = useState('create');
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [shareCode, setShareCode] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const device =
        mode === 'create'
          ? await addDevice({ name: name.trim() || suggestedName, location: location.trim() })
          : await joinDevice(shareCode);
      // replace: this page shouldn't sit in history behind the device
      // you just landed on - back should go to the list.
      navigate(`/devices/${device._id}`, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleModeChange = (next) => {
    setMode(next);
    setError(null); // an error about the other mode isn't relevant any more
  };

  return (
    <section>
      <Link className={styles.back} to="/">
        ‹ All doorbells
      </Link>

      <p className={styles.heading}>Add a doorbell</p>

      <SegmentedControl options={MODES} value={mode} onChange={handleModeChange} />

      {error && <p className={styles.error}>{error}</p>}

      <form onSubmit={handleSubmit}>
        {mode === 'create' ? (
          <>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="device-name">
                Name
              </label>
              <p className={styles.help}>What you&apos;ll call it in the app</p>
              <input
                id="device-name"
                className={styles.input}
                type="text"
                maxLength={40}
                placeholder={suggestedName}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="device-location">
                Location
              </label>
              <p className={styles.help}>Optional — helps once you have more than one</p>
              <input
                id="device-location"
                className={styles.input}
                type="text"
                maxLength={40}
                placeholder="e.g. Front porch"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </div>
          </>
        ) : (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="share-code">
              Share code
            </label>
            <p className={styles.help}>
              Ask whoever set the doorbell up — they&apos;ll find it under its Settings.
            </p>
            <input
              id="share-code"
              className={`${styles.input} ${styles.codeInput}`}
              type="text"
              required
              placeholder="PORCH-7K2M9P"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck="false"
              value={shareCode}
              onChange={(e) => setShareCode(e.target.value)}
            />
          </div>
        )}

        <button className={styles.submit} type="submit" disabled={submitting}>
          {submitting
            ? mode === 'create'
              ? 'Setting up…'
              : 'Joining…'
            : mode === 'create'
              ? 'Set up doorbell'
              : 'Join doorbell'}
        </button>
      </form>
    </section>
  );
}
