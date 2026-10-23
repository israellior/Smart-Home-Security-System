import { Device } from '../models/Device.js';
import { Membership } from '../models/Membership.js';
import { Event } from '../models/Event.js';
import { Clip } from '../models/Clip.js';
import { Person } from '../models/Person.js';
import {
  storageConfigured,
  deleteClipObjects,
  deleteFaceObjects,
  faceKey
} from '../config/storage.js';
import { disconnectHardware } from '../signaling/index.js';

/**
 * Deletes a doorbell and everything that belongs to it, for everyone:
 * its clips in the bucket, its events, every membership, the device, and
 * the hardware's connection.
 *
 * Shared by "Delete this doorbell" and by deleting an account, which
 * deletes every doorbell that account owns. One function so the two can
 * never disagree about what "deleted" leaves behind.
 */
export async function purgeDevice(device) {
  const deviceId = device._id;

  // Recordings first, and the bucket before the rows that point at it.
  // A deleted doorbell leaving its video behind is the one failure here
  // with a privacy cost - the other orphans are only clutter - and once
  // the Clip rows are gone there is nothing left that knows the objects
  // exist. Best-effort: a bucket that is unreachable must not block
  // someone deleting their doorbell.
  if (storageConfigured && device.deviceId) {
    const clips = await Clip.find({ device: deviceId }, { eventId: 1 });
    if (clips.length > 0) {
      try {
        await deleteClipObjects(device.deviceId, clips.map((c) => c.eventId));
      } catch (err) {
        console.error(`Could not remove clips for ${device.deviceId}:`, err.message);
      }
    }
  }
  await Clip.deleteMany({ device: deviceId });

  // The people it knew, and their faces - the same privacy cost as the
  // clips, and the same order: the bucket before the rows that know where
  // the photos are.
  const people = await Person.find({ device: deviceId }, { personId: 1, photos: 1 }).lean();
  if (storageConfigured && device.deviceId && people.length > 0) {
    const keys = people.flatMap((p) => p.photos.map((ph) => faceKey(device.deviceId, p.personId, ph.photoId)));
    try {
      await deleteFaceObjects(keys);
    } catch (err) {
      console.error(`Could not remove face photos for ${device.deviceId}:`, err.message);
    }
  }
  await Person.deleteMany({ device: deviceId });

  // Mongo has no cascading deletes, so orphaned events and memberships
  // are ours to clean up. Events first: if this dies halfway, a device
  // with no events is a better failure than events pointing at nothing.
  await Event.deleteMany({ device: deviceId });
  await Membership.deleteMany({ device: deviceId });
  await Device.deleteOne({ _id: deviceId });

  // Tell the hardware, and only now that the record is actually gone -
  // closing first would leave a window in which the doorbell reconnects
  // and re-registers against a device we are halfway through deleting.
  //
  // This is the one refusal in the system that is genuinely permanent, so
  // it is the one place the device is closed with 4002 unprompted: the
  // credential will never authenticate again, and a doorbell that is
  // never told keeps a socket open to a server that 401s its every call.
  // No fault LED, no reconnect, nothing at the house to suggest anything
  // is wrong. Which is also why deleting deserves a confirmation that
  // says what it does to the unit on the wall.
  disconnectHardware(String(deviceId), 'This doorbell was deleted');
}
