import { randomBytes } from 'node:crypto';
import { Device } from '../models/Device.js';
import { Person } from '../models/Person.js';
import { storageConfigured, faceKey, signFaceDownload } from '../config/storage.js';
import * as registry from '../signaling/registry.js';

/**
 * The people a doorbell knows by face - this side of "Faces" in the device
 * repo's docs/server-brief.md.
 *
 * The doorbell decides who is at the door, on its own, from codes it makes
 * itself. This side keeps the list, the photos and the names, and makes sure
 * the doorbell has the current list:
 *
 *   - Every change raises Device.facesRevision and sends the whole list to
 *     the doorbell if it is online. Whole, never a change to it, so leaving
 *     someone out is how they are deleted, and a list that got lost is
 *     repaired by the next one.
 *   - Every hello reports the revision the doorbell last applied. Anything
 *     other than the current one - including null, a doorbell that has never
 *     had a list or whose codes came from a model it no longer runs - gets
 *     the list again.
 *   - The doorbell answers per photo, and that becomes each photo's state,
 *     which the app shows: a photo it could not use says why.
 */

export const MAX_PEOPLE = 10;
export const MAX_PHOTOS = 20;
export const MAX_PHOTO_BYTES = 200 * 1024;

// What a doorbell may answer, word for word. Anything else is stored as the
// general one, rather than as whatever arrived.
const ERRORS = ['no face', 'more than one face', 'face too small', 'could not download', 'not a picture'];

// Failures that will fail the same way next time: the photo is not sent
// again, and only a new one helps. A download that failed may work tomorrow.
const PERMANENT = new Set(['no face', 'more than one face', 'face too small', 'not a picture']);

const ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * "p_" or "f_" and nine random characters. Random rather than counted, so an
 * id says nothing about how many people a doorbell knows or in what order
 * they were added; short, because the doorbell logs them.
 */
export function newId(prefix) {
  return `${prefix}_${randomBytes(7).toString('base64url').slice(0, 9)}`;
}

export function isId(value) {
  return typeof value === 'string' && ID.test(value);
}

function send(socket, payload) {
  if (!socket || socket.readyState !== socket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function toBrowsers(deviceKey, payload) {
  for (const socket of registry.browserSockets(deviceKey)) send(socket, payload);
}

/** The frame the brief describes: everyone, and a signed URL per photo. */
async function syncFrame(device) {
  const people = await Person.find({ device: device._id }).sort({ createdAt: 1 }).lean();
  const listed = [];
  for (const person of people) {
    const photos = [];
    for (const photo of person.photos) {
      if (photo.state === 'failed' && PERMANENT.has(photo.error)) continue;
      photos.push({
        id: photo.photoId,
        url: await signFaceDownload(faceKey(device.deviceId, person.personId, photo.photoId))
      });
    }
    listed.push({ id: person.personId, photos });
  }
  return { type: 'faces-sync', revision: device.facesRevision ?? 0, people: listed };
}

/**
 * Sends the current list to the doorbell, if it is online and can use it.
 * Returns whether it went. A doorbell that is offline is not owed anything:
 * its next hello reports an old revision and gets the list then.
 */
export async function sendFaces(device) {
  const socket = registry.deviceSocket(String(device._id));
  if (!socket || !socket.ctx?.faces || !storageConfigured || !device.deviceId) return false;
  const frame = await syncFrame(device);
  const sent = send(socket, frame);
  if (sent) {
    const photos = frame.people.reduce((n, p) => n + p.photos.length, 0);
    console.log(`Faces: list ${frame.revision} sent to ${device.deviceId} - ${frame.people.length} people, ${photos} photos`);
  }
  return sent;
}

/**
 * The list changed: raise the revision, tell anyone with the doorbell open,
 * and send it. Called after the change is stored, so a doorbell that asks in
 * between is sent the new list, never a half-made one.
 */
export async function facesChanged(deviceId) {
  const device = await Device.findByIdAndUpdate(deviceId, { $inc: { facesRevision: 1 } }, { new: true });
  if (!device) return;
  toBrowsers(String(device._id), { type: 'faces-changed', revision: device.facesRevision });
  await sendFaces(device);
}

/**
 * Every doorbell hello: whether it can recognise faces, with which model,
 * and which list it has. Behind, or never had one: it is sent the list.
 */
export async function onFacesHello(device, frame) {
  const faces = frame.faces && typeof frame.faces === 'object' ? frame.faces : null;
  const model = faces && typeof faces.model === 'string' ? faces.model.slice(0, 64) : null;
  const revision = faces && Number.isInteger(faces.revision) ? faces.revision : null;
  const fresh = await Device.findByIdAndUpdate(
    device._id,
    { $set: { faces: faces ? { model, revision, reportedAt: new Date() } : null } },
    { new: true }
  );
  if (!fresh || !faces) return;
  if (revision !== (fresh.facesRevision ?? 0)) await sendFaces(fresh);
}

/**
 * The doorbell's answer to a list: per photo, usable or why not. Stored on
 * each photo, so the app can show it, and the revision it applied stored on
 * the device. Matched on the doorbell's own photo ids - a photo deleted
 * since simply matches nothing.
 */
export async function handleFacesStatus(device, frame) {
  const photos = Array.isArray(frame.photos) ? frame.photos.slice(0, MAX_PEOPLE * MAX_PHOTOS) : [];
  const updates = photos
    .filter((p) => p && isId(p.id))
    .map((p) => {
      const ok = p.ok === true;
      const error = ok ? null : ERRORS.includes(p.error) ? p.error : 'could not download';
      return {
        updateOne: {
          filter: { device: device._id, 'photos.photoId': p.id },
          update: { $set: { 'photos.$.state': ok ? 'ok' : 'failed', 'photos.$.error': error } }
        }
      };
    });
  if (updates.length > 0) await Person.bulkWrite(updates, { ordered: false });

  if (Number.isInteger(frame.revision)) {
    await Device.updateOne({ _id: device._id }, { $set: { 'faces.revision': frame.revision } });
  }
  const usable = photos.filter((p) => p?.ok === true).length;
  console.log(`Faces: ${device.deviceId} applied list ${frame.revision} - ${usable} of ${photos.length} photos usable`);
  toBrowsers(String(device._id), { type: 'faces-changed', revision: frame.revision });
}

function namedIn(event) {
  const faces = event?.meta?.faces;
  if (!Array.isArray(faces)) return [];
  return faces.slice(0, 4).map((face) => face?.person).filter(isId);
}

/**
 * Who each alert says was at the door, by name, in the order given - null
 * where nobody known. The first entry naming someone this doorbell still
 * knows; a person deleted since the alert was raised is nobody. One query for
 * any number of events, so a page of the activity list costs one lookup.
 */
export async function visitorNames(deviceId, events) {
  const ids = [...new Set(events.flatMap(namedIn))];
  if (ids.length === 0) return events.map(() => null);
  const people = await Person.find(
    { device: deviceId, personId: { $in: ids } },
    { personId: 1, name: 1 }
  ).lean();
  const names = new Map(people.map((p) => [p.personId, p.name]));
  return events.map((event) => {
    const known = namedIn(event).find((id) => names.has(id));
    return known ? names.get(known) : null;
  });
}

/** One alert's visitor, for its notification - see visitorNames. */
export async function knownVisitor(device, event) {
  const [name] = await visitorNames(device._id, [event]);
  return name;
}
