/**
 * Saves someone's face on a doorbell from JPEG files, before the app has a
 * way to - and then waits to hear what the doorbell made of each photo.
 *
 *   node scripts/add-face.mjs --name Lior photo1.jpg photo2.jpg ...
 *   node scripts/add-face.mjs --name Lior --device "Front Door" photo.jpg
 *   node scripts/add-face.mjs --list                    # who is saved
 *   node scripts/add-face.mjs --remove p_3k9x2m         # forget someone
 *
 * Credentials from --email / --password or PORCHLIGHT_EMAIL /
 * PORCHLIGHT_PASSWORD, as for ring.mjs. The account must own the doorbell.
 *
 * Through the running server, not the database, for the reason ring.mjs
 * gives: what is being tested is the whole path - stored, the revision
 * raised, the list sent to the doorbell, the doorbell's answer stored on
 * each photo. Writing rows directly would test none of it.
 *
 * Photos should be one face each, cropped with some room around it, about
 * 256x256 and under 200 KB. A phone selfie is too big as it comes: crop it
 * first. The doorbell answers per photo - "no face", "face too small",
 * "more than one face" - and a photo it cannot use is simply not used.
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}
const has = (flag) => process.argv.includes(flag);

const API = arg('--api') || process.env.VITE_API_URL || 'http://localhost:4000/api';
const email = arg('--email') || process.env.PORCHLIGHT_EMAIL;
const password = arg('--password') || process.env.PORCHLIGHT_PASSWORD;
const wanted = arg('--device');
const name = arg('--name');
const removeId = arg('--remove');
const FLAGS_WITH_VALUES = ['--api', '--email', '--password', '--device', '--name', '--remove'];
const files = process.argv
  .slice(2)
  .filter((a, i, all) => !a.startsWith('--') && !FLAGS_WITH_VALUES.includes(all[i - 1]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { method = 'GET', body, token, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (raw) headers['Content-Type'] = 'image/jpeg';
  else if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: raw ?? (body ? JSON.stringify(body) : undefined)
    });
  } catch (err) {
    const cause = err.cause?.code || err.cause?.message || err.message;
    throw new Error(`Could not reach ${API} (${cause}) - is the server running?`);
  }
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
  return data;
}

function show(people) {
  if (people.length === 0) return console.log('  nobody saved');
  for (const p of people) {
    const ok = p.photos.filter((ph) => ph.state === 'ok').length;
    console.log(`  ${p.id}  ${p.name}  - ${ok} of ${p.photos.length} photos usable`);
    for (const ph of p.photos) {
      console.log(`      ${ph.id}  ${ph.state}${ph.error ? ` (${ph.error})` : ''}`);
    }
  }
}

async function main() {
  if (!email || !password) {
    throw new Error('Need the owner account: --email you@example.com --password secret');
  }
  const { token } = await call('/auth/login', { method: 'POST', body: { email, password } });
  const { devices } = await call('/devices', { token });
  const device = wanted
    ? devices.find((d) => d._id === wanted || d.name.toLowerCase().includes(wanted.toLowerCase()))
    : devices[0];
  if (!device) throw new Error(`No doorbell matching "${wanted}"`);
  const base = `/devices/${device._id}/faces`;

  if (removeId) {
    await call(`${base}/${removeId}`, { method: 'DELETE', token });
    console.log(`${removeId} forgotten by ${device.name}`);
  }

  if (name) {
    if (files.length === 0) throw new Error('Give one or more JPEG files after --name');
    const { people } = await call(base, { token });
    let person = people.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!person) {
      ({ person } = await call(base, { method: 'POST', token, body: { name } }));
      console.log(`${name} added to ${device.name} as ${person.id}`);
    }
    for (const file of files) {
      const bytes = await readFile(file);
      await call(`${base}/${person.id}/photos`, { method: 'POST', token, raw: bytes });
      console.log(`  ${basename(file)}: ${Math.round(bytes.length / 1024)} KB sent`);
    }

    // The doorbell codes them on its own time - a second or so each - and
    // its answer lands on each photo. Waited for, so this says how it went.
    console.log('\nWaiting for the doorbell...');
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const list = await call(base, { token });
      const mine = list.people.find((p) => p.id === person.id);
      if (mine && mine.photos.every((ph) => ph.state !== 'pending')) break;
      if (!list.doorbell.canRecognise) {
        console.log('The doorbell has not said it can recognise faces - is it online, on a release that can?');
        break;
      }
      await sleep(2000);
    }
  }

  const list = await call(base, { token });
  console.log(`\n${device.name} - list ${list.revision}, ` +
    `doorbell ${list.doorbell.canRecognise ? (list.doorbell.applied ? 'up to date' : 'not yet up to date') : 'cannot recognise faces'}`);
  show(list.people);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
