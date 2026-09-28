import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useDevices } from '../context/DevicesContext';
import { SegmentedControl } from '../components/SegmentedControl';
import styles from './AddDevice.module.css';

const MODES = [
  { value: 'claim', label: 'New doorbell' },
  { value: 'join', label: 'Share code' },
  { value: 'create', label: 'Set up later' }
];

/**
 * Three ways to get a doorbell onto your list, and the first two take
 * codes that are deliberately not interchangeable.
 *
 *   claim   the one-time code on a new unit. Makes you its owner, and is
 *           spent by doing it - a second person with the same code, or the
 *           same photograph of the sticker, is told it has been used.
 *   join    a code an owner generated inside the app for you. Makes you a
 *           member, and never an owner.
 *   create  a doorbell in the app before any hardware exists for it.
 *
 * Collapsing the first two into one box is tempting and wrong. A share code
 * is permanent and a doorbell is bolted to the outside of a house: if the
 * code printed on the case granted ongoing access, anyone who photographed
 * the unit could watch that door forever. So one code is consumed and the
 * other is revocable, and the app keeps the two apart where the person is,
 * not only where the server is.
 */
// A table rather than nested ternaries: three modes times two states is
// where the conditional expression that used to be here stopped being
// readable.
const SUBMIT_LABEL = {
  claim: { idle: 'Claim this doorbell', busy: 'Claiming…' },
  join: { idle: 'Join doorbell', busy: 'Joining…' },
  create: { idle: 'Set up doorbell', busy: 'Setting up…' }
};

export function AddDevice() {
  const { devices, addDevice, claimDevice, joinDevice } = useDevices();
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

  // Claiming first: somebody arriving here is far more often holding a new
  // doorbell than a code a flatmate sent them.
  const [mode, setMode] = useState('claim');
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [claimCode, setClaimCode] = useState('');
  const [shareCode, setShareCode] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      let device;
      if (mode === 'claim') device = await claimDevice(claimCode);
      else if (mode === 'join') device = await joinDevice(shareCode);
      else device = await addDevice({ name: name.trim() || suggestedName, location: location.trim() });
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
        {mode === 'claim' && (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="claim-code">
              Claim code
            </label>
            <p className={styles.help}>
              Six characters, on the sticker on the back of the doorbell and on its setup page.
              It works once — after this it belongs to you, and you share it from the app.
            </p>
            <input
              id="claim-code"
              className={`${styles.input} ${styles.codeInput}`}
              type="text"
              required
              maxLength={12}
              placeholder="7K2M9P"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck="false"
              value={claimCode}
              onChange={(e) => setClaimCode(e.target.value)}
            />
          </div>
        )}

        {mode === 'create' && (
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
            <p className={styles.help}>
              For a doorbell you have not got yet. It appears on your list straight away, with
              no camera behind it until hardware is paired to it.
            </p>
          </>
        )}

        {mode === 'join' && (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="share-code">
              Share code
            </label>
            <p className={styles.help}>
              Ask whoever set the doorbell up — they create one under its Settings. It starts
              with PORCH-, and it is not the code printed on the doorbell itself.
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
          {SUBMIT_LABEL[mode][submitting ? 'busy' : 'idle']}
        </button>
      </form>
    </section>
  );
}
