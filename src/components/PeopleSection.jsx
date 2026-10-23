import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useDeviceLive } from './DeviceLayout';
import { FaceScan } from './FaceScan';
import { api } from '../api/client';
import styles from './PeopleSection.module.css';

/*
 * The people this doorbell knows by face, so that an alert can say "Lior is
 * at the door" instead of "Motion detected".
 *
 * A face is added by scanning it here; the photos go to the server, and the
 * doorbell fetches them and learns the face itself - it keeps codes, never
 * pictures or names. It answers per photo, on the socket, as it finishes,
 * which is when this list is fetched again: "learning" turns into "known
 * from 12 photos" while you watch.
 *
 * Anyone with the doorbell sees who is saved. Only the owner adds, renames or
 * removes anyone, as the server insists.
 */

// What the doorbell says about a photo it could not use, in words.
const PHOTO_PROBLEMS = {
  'no face': 'no face found',
  'more than one face': 'more than one face',
  'face too small': 'face too small',
  'could not download': 'could not be fetched',
  'not a picture': 'not a picture'
};

function count(person, state) {
  return person.photos.filter((p) => p.state === state).length;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Where one person stands with the doorbell, in a line. */
function learningLine(person, doorbell, online) {
  const total = person.photos.length;
  const ok = count(person, 'ok');
  const failed = count(person, 'failed');
  const pending = count(person, 'pending');
  if (total === 0) return { text: 'No photos yet — scan their face', tone: 'bad' };
  if (pending > 0) {
    if (!doorbell?.canRecognise) {
      return { text: `${plural(total, 'photo')} — this doorbell can't recognise faces yet`, tone: 'quiet' };
    }
    if (!online) {
      return { text: `${plural(pending, 'photo')} waiting for the doorbell to come online`, tone: 'quiet' };
    }
    return { text: `Learning — ${ok + failed} of ${total} photos done`, tone: 'busy' };
  }
  if (ok === 0) return { text: `None of the ${total} photos could be used — scan again`, tone: 'bad' };
  return {
    text: `Known from ${plural(ok, 'photo')}${failed ? ` · ${failed} not usable` : ''}`,
    tone: 'good'
  };
}

/**
 * How the doorbell is getting on with the photos one scan sent, for the end
 * of that scan - counting only those, so a second scan of someone already
 * known shows its own progress. Null until the person is in the list.
 */
function scanProgress(scan, people, doorbell, online) {
  const person = scan?.personId && people.find((p) => p.id === scan.personId);
  if (!person) return null;
  const fresh = person.photos.filter((p) => !scan.before.includes(p.id));
  return {
    fresh: fresh.length,
    learned: fresh.filter((p) => p.state !== 'pending').length,
    usable: fresh.filter((p) => p.state === 'ok').length,
    knownFrom: count(person, 'ok'),
    online,
    canRecognise: Boolean(doorbell?.canRecognise)
  };
}

function problemsOf(person) {
  const said = new Set(
    person.photos.filter((p) => p.state === 'failed').map((p) => PHOTO_PROBLEMS[p.error] || p.error)
  );
  return said.size ? `Not usable: ${[...said].join(', ')}` : undefined;
}

export function PeopleSection({ device, canManage }) {
  const { token } = useAuth();
  const { facesChanged } = useDeviceLive();

  const [data, setData] = useState(undefined); // undefined while loading
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  // The scan on screen: who it is for, and - once the person exists - their
  // id, so a second go after a failed upload adds to them rather than making
  // a second person. `attempt` remounts FaceScan for each go.
  const [scan, setScan] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.listPeople(token, device._id));
      setError(null);
    } catch (err) {
      setData((previous) => previous ?? null);
      setError(err.message);
    }
  }, [token, device._id]);

  // Again whenever the socket says the faces changed - which includes the
  // doorbell reporting on photos it has just learned.
  useEffect(() => {
    load();
  }, [load, facesChanged]);

  const people = data?.people ?? [];
  const limits = data?.limits ?? { people: 10, photos: 20 };
  const doorbell = data?.doorbell;
  const online = device.status === 'online';

  const startAdding = () => {
    setAdding(true);
    setNewName('');
    setError(null);
  };

  const scanNew = (event) => {
    event.preventDefault();
    const name = newName.trim().replace(/\s+/g, ' ');
    if (!name) return;
    setAdding(false);
    setScan({ name, personId: null, room: limits.photos, before: [], attempt: 1 });
  };

  // `before` is the photos they already had, so the end of the scan can
  // tell this scan's photos from the earlier ones.
  const scanMore = (person) => {
    setScan({
      name: person.name,
      personId: person.id,
      room: limits.photos - person.photos.length,
      before: person.photos.map((p) => p.id),
      attempt: 1
    });
  };

  // The person is made only once there are photos to give them, so a scan
  // abandoned halfway leaves nobody behind.
  const saveScan = async (photos, progress) => {
    let personId = scan.personId;
    if (!personId) {
      const { person } = await api.createPerson(token, device._id, scan.name);
      personId = person.id;
      setScan((current) => current && { ...current, personId });
    }
    for (let i = 0; i < photos.length; i += 1) {
      await api.addFacePhoto(token, device._id, personId, photos[i]);
      progress(i + 1, photos.length);
    }
    load();
  };

  const saveName = async (event) => {
    event.preventDefault();
    const name = renaming.name.trim().replace(/\s+/g, ' ');
    if (!name) return;
    setBusy(true);
    try {
      await api.renamePerson(token, device._id, renaming.id, name);
      setRenaming(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (person) => {
    setBusy(true);
    try {
      await api.deletePerson(token, device._id, person.id);
      setDeleting(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className={styles.sectionLabel}>People it knows</p>
      <div className={styles.group}>
        <p className={styles.help}>
          When the doorbell recognises someone, alerts say who it is — “{people[0]?.name || 'Sam'} is
          at the door”. The doorbell learns each face itself and keeps no pictures; the photos stay
          with your account, so it can learn them again after an update.
        </p>

        {data === undefined && <p className={styles.muted}>Loading…</p>}

        {doorbell && !doorbell.canRecognise && (
          <div className={`${styles.status} ${styles.tone_quiet}`}>
            <p className={styles.statusText}>
              This doorbell can&apos;t recognise faces yet — it needs a software update. People saved
              now are learned once it has one.
            </p>
          </div>
        )}

        {people.map((person) => {
          const line = learningLine(person, doorbell, online);
          const isRenaming = renaming?.id === person.id;
          const isDeleting = deleting === person.id;
          return (
            <div key={person.id} className={styles.person}>
              {isRenaming ? (
                <form className={styles.inline} onSubmit={saveName}>
                  <input
                    className={styles.textInput}
                    value={renaming.name}
                    maxLength={60}
                    autoFocus
                    aria-label="Name"
                    onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                  />
                  <button type="submit" className={styles.linkBtn} disabled={busy}>
                    Save
                  </button>
                  <button type="button" className={styles.linkBtn} onClick={() => setRenaming(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <p className={styles.name}>{person.name}</p>
              )}
              <p className={`${styles.line} ${styles[`text_${line.tone}`]}`} title={problemsOf(person)}>
                {line.text}
              </p>

              {canManage && !isRenaming && !isDeleting && (
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.linkBtn}
                    onClick={() => setRenaming({ id: person.id, name: person.name })}
                  >
                    Rename
                  </button>
                  {person.photos.length < limits.photos && (
                    <button type="button" className={styles.linkBtn} onClick={() => scanMore(person)}>
                      {person.photos.length ? 'Scan again' : 'Scan face'}
                    </button>
                  )}
                  <button type="button" className={styles.linkBtnDanger} onClick={() => setDeleting(person.id)}>
                    Delete
                  </button>
                </div>
              )}
              {isDeleting && (
                <div className={styles.confirm}>
                  <p className={styles.confirmText}>
                    Forget {person.name}? Their photos are deleted, and the doorbell stops knowing
                    them.
                  </p>
                  <button
                    type="button"
                    className={styles.dangerBtn}
                    disabled={busy}
                    onClick={() => remove(person)}
                  >
                    {busy ? 'Deleting…' : 'Delete'}
                  </button>
                  <button type="button" className={styles.linkBtn} onClick={() => setDeleting(null)}>
                    Keep
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {canManage && data && !adding && people.length < limits.people && (
          <button type="button" className={styles.addBtn} onClick={startAdding}>
            Add a person
          </button>
        )}
        {canManage && data && people.length >= limits.people && (
          <p className={styles.hint}>A doorbell can know at most {limits.people} people.</p>
        )}

        {adding && (
          <form className={styles.addForm} onSubmit={scanNew}>
            <label className={styles.fieldLabel} htmlFor="new-person-name">
              Their name
            </label>
            <p className={styles.hint}>
              As it should appear in alerts. Then the camera opens: look at it, and slowly move your
              head in a circle, twice.
            </p>
            <input
              id="new-person-name"
              className={styles.textInput}
              value={newName}
              maxLength={60}
              autoFocus
              onChange={(e) => setNewName(e.target.value)}
            />
            <div className={styles.formActions}>
              <button type="submit" className={styles.addBtn} disabled={!newName.trim()}>
                Scan face
              </button>
              <button type="button" className={styles.linkBtn} onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {!canManage && <p className={styles.hint}>Only the owner can add or remove people.</p>}
        {error && <p className={styles.error}>{error}</p>}
      </div>

      {scan && (
        <FaceScan
          key={scan.attempt}
          name={scan.name}
          doorbellName={device.name}
          maxPhotos={scan.room}
          learning={scanProgress(scan, people, doorbell, online)}
          onCaptured={saveScan}
          onRetry={() =>
            setScan((current) => {
              if (!current) return current;
              // Whatever the last go saved now counts as "before" too.
              const person = people.find((p) => p.id === current.personId);
              return person
                ? {
                    ...current,
                    attempt: current.attempt + 1,
                    before: person.photos.map((p) => p.id),
                    room: limits.photos - person.photos.length
                  }
                : { ...current, attempt: current.attempt + 1 };
            })
          }
          onClose={() => {
            setScan(null);
            load();
          }}
        />
      )}
    </>
  );
}
