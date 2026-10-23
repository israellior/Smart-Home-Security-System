import { Person } from '../models/Person.js';
import {
  storageConfigured,
  faceKey,
  putFacePhoto,
  signFaceDownload,
  deleteFaceObjects
} from '../config/storage.js';
import {
  MAX_PEOPLE,
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  newId,
  isId,
  facesChanged
} from '../services/faces.js';

/**
 * The people a doorbell knows by face. See services/faces.js for how the
 * list reaches the doorbell.
 *
 * Any member sees who is saved. Only an owner adds, renames or removes
 * anyone: a face is the most personal thing this app holds, and saving one
 * changes what every member's notifications say about a person.
 */

function noStorage(res) {
  return res.status(503).json({ error: 'Photo storage is not set up on this server.' });
}

async function personOf(req, res) {
  if (!isId(req.params.personId)) {
    res.status(404).json({ error: 'Person not found' });
    return null;
  }
  const person = await Person.findOne({ device: req.device._id, personId: req.params.personId });
  if (!person) res.status(404).json({ error: 'Person not found' });
  return person;
}

function view(person) {
  return {
    id: person.personId,
    name: person.name,
    photos: person.photos.map((p) => ({
      id: p.photoId,
      state: p.state,
      error: p.error,
      addedAt: p.addedAt
    })),
    createdAt: person.createdAt
  };
}

/**
 * Everyone this doorbell knows, and whether the doorbell has the latest list
 * - `applied` false is a doorbell that is offline or still coding photos.
 */
export async function listPeople(req, res) {
  const people = await Person.find({ device: req.device._id }).sort({ createdAt: 1 });
  const device = req.device;
  return res.json({
    people: people.map(view),
    revision: device.facesRevision ?? 0,
    doorbell: {
      canRecognise: Boolean(device.faces),
      applied: device.faces ? device.faces.revision === (device.facesRevision ?? 0) : false
    },
    limits: { people: MAX_PEOPLE, photos: MAX_PHOTOS, photoBytes: MAX_PHOTO_BYTES }
  });
}

function cleanName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

export async function createPerson(req, res) {
  const name = cleanName(req.body?.name);
  if (!name || name.length > 60) {
    return res.status(400).json({ error: 'A name of 1 to 60 characters' });
  }
  const count = await Person.countDocuments({ device: req.device._id });
  if (count >= MAX_PEOPLE) {
    return res.status(409).json({ error: `A doorbell can know at most ${MAX_PEOPLE} people.` });
  }
  const person = await Person.create({
    device: req.device._id,
    personId: newId('p'),
    name,
    addedBy: req.userId
  });
  // No photos yet, so nothing for the doorbell to learn: the list changes
  // when the first photo is added.
  return res.status(201).json({ person: view(person) });
}

export async function renamePerson(req, res) {
  const person = await personOf(req, res);
  if (!person) return;
  const name = cleanName(req.body?.name);
  if (!name || name.length > 60) {
    return res.status(400).json({ error: 'A name of 1 to 60 characters' });
  }
  person.name = name;
  await person.save();
  // The doorbell never knew the name, so it is not sent anything.
  return res.json({ person: view(person) });
}

export async function deletePerson(req, res) {
  const person = await personOf(req, res);
  if (!person) return;
  const keys = person.photos.map((p) => faceKey(req.device.deviceId, person.personId, p.photoId));
  await Person.deleteOne({ _id: person._id });
  // The record first: a doorbell asking in between is sent a list without
  // them. A photo the bucket fails to delete is only clutter once nothing
  // points at it, and is logged so it can be found.
  if (storageConfigured && keys.length > 0) {
    const failed = await deleteFaceObjects(keys).catch(() => keys.length);
    if (failed) console.error(`Faces: ${failed} photo(s) of a deleted person left in the bucket`);
  }
  await facesChanged(req.device._id);
  return res.status(204).end();
}

/**
 * One photo, as the body - `Content-Type: image/jpeg`, at most
 * MAX_PHOTO_BYTES. A cropped face from the app's scan; the doorbell finds the
 * face in it again itself, so the crop does not have to be exact.
 */
export async function addPhoto(req, res) {
  if (!storageConfigured || !req.device.deviceId) return noStorage(res);
  const person = await personOf(req, res);
  if (!person) return;

  const bytes = req.body;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    return res.status(400).json({ error: 'Send the photo as image/jpeg' });
  }
  // JPEG's own first three bytes. Anything else would only come back from
  // the doorbell as "not a picture", after a round trip.
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return res.status(400).json({ error: 'That is not a JPEG' });
  }
  if (person.photos.length >= MAX_PHOTOS) {
    return res.status(409).json({ error: `At most ${MAX_PHOTOS} photos of one person.` });
  }

  const photoId = newId('f');
  await putFacePhoto(faceKey(req.device.deviceId, person.personId, photoId), bytes);
  person.photos.push({ photoId, bytes: bytes.length, state: 'pending' });
  await person.save();
  await facesChanged(req.device._id);
  return res.status(201).json({ person: view(person) });
}

export async function deletePhoto(req, res) {
  const person = await personOf(req, res);
  if (!person) return;
  const { photoId } = req.params;
  if (!isId(photoId) || !person.photos.some((p) => p.photoId === photoId)) {
    return res.status(404).json({ error: 'Photo not found' });
  }
  person.photos = person.photos.filter((p) => p.photoId !== photoId);
  await person.save();
  if (storageConfigured) {
    await deleteFaceObjects([faceKey(req.device.deviceId, person.personId, photoId)]).catch(() => 1);
  }
  await facesChanged(req.device._id);
  return res.json({ person: view(person) });
}

/** A short-lived link to one saved photo, for the app to show it. */
export async function getPhotoUrl(req, res) {
  if (!storageConfigured || !req.device.deviceId) return noStorage(res);
  const person = await personOf(req, res);
  if (!person) return;
  const { photoId } = req.params;
  if (!isId(photoId) || !person.photos.some((p) => p.photoId === photoId)) {
    return res.status(404).json({ error: 'Photo not found' });
  }
  const url = await signFaceDownload(faceKey(req.device.deviceId, person.personId, photoId));
  return res.json({ url });
}
