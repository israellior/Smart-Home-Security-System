import { Router } from 'express';
import {
  listDevices,
  getDevice,
  createDevice,
  joinDevice,
  claimDevice,
  createShareCode,
  revokeShareCode,
  updateDevice,
  updatePreferences,
  markDeviceSeen,
  deleteDevice,
  listMembers,
  removeMember
} from '../controllers/deviceController.js';
import { listEvents, createEvent } from '../controllers/eventController.js';
import { getClipUrl } from '../controllers/clipController.js';
import {
  createRecording,
  confirmRecording,
  takeRecordingTurn,
  releaseRecordingTurn
} from '../controllers/recordingController.js';
import { getViewerToken, takeTalk, releaseTalk } from '../controllers/mediaController.js';
import { requireAuth } from '../middleware/auth.js';
import { requireDeviceAccess, requireDeviceOwner } from '../middleware/deviceAccess.js';

export const deviceRoutes = Router();

deviceRoutes.use(requireAuth); // every route below requires a logged-in user

// Collection-level. /join and /claim are declared before the /:id routes
// so they're matched as literal paths rather than swallowed as device ids.
deviceRoutes.get('/', listDevices);
deviceRoutes.post('/', createDevice);

// The two codes, and they are not interchangeable.
//
//   /claim  the one-time code on the unit. Makes you its owner, once, and
//           is consumed. This is the only route that creates ownership of
//           hardware.
//   /join   a code an owner generated inside the app for a flatmate.
//           Makes you a member, and never an owner.
//
// Collapsing them back into one endpoint is the mistake this split exists
// to prevent: the code printed on a doorbell bolted to the outside of a
// house cannot be the code that grants permanent access to its camera.
deviceRoutes.post('/claim', claimDevice);
deviceRoutes.post('/join', joinDevice);

// Everything below is scoped to one device the caller is a member of.
// requireDeviceAccess loads req.device / req.membership; requireDeviceOwner
// stacks on top for the two actions members shouldn't have.
deviceRoutes.get('/:id', requireDeviceAccess, getDevice);
deviceRoutes.patch('/:id', requireDeviceAccess, updateDevice);
// Writes the caller's membership rather than the device, so it needs no
// owner check: it can only ever change the caller's own preferences.
deviceRoutes.patch('/:id/preferences', requireDeviceAccess, updatePreferences);
// Same shape: writes only the caller's own membership watermark.
deviceRoutes.post('/:id/seen', requireDeviceAccess, markDeviceSeen);
deviceRoutes.delete('/:id', requireDeviceAccess, requireDeviceOwner, deleteDevice);

// Share codes are made and unmade by the owner, on demand. Nothing mints
// one at creation any more and nothing prints one on hardware, so these
// two are the only way a share code comes into existence.
deviceRoutes.post('/:id/share-code', requireDeviceAccess, requireDeviceOwner, createShareCode);
deviceRoutes.delete('/:id/share-code', requireDeviceAccess, requireDeviceOwner, revokeShareCode);

deviceRoutes.get('/:id/members', requireDeviceAccess, listMembers);
// No requireDeviceOwner here: removing *yourself* is "leave", which any
// member may do. The controller distinguishes the two cases.
deviceRoutes.delete('/:id/members/:userId', requireDeviceAccess, removeMember);

deviceRoutes.get('/:deviceId/events', requireDeviceAccess, listEvents);
deviceRoutes.post('/:deviceId/events', requireDeviceAccess, createEvent);

// Playback. Hands back a short-lived signed URL rather than the file, so
// the browser fetches from the bucket and this server stays out of the
// path for recorded media as well as live.
deviceRoutes.get('/:deviceId/events/:eventId/clip', requireDeviceAccess, getClipUrl);

// Recording from the live view. /record is the turn - one member at a
// time, first press holds it - and /recordings is the upload: same three
// steps as a doorbell's clip -
// grant, PUT to the bucket, confirm - but asked for by a member's browser,
// which is the only thing holding the picture while a call is up. Any
// member may record; confirm only accepts the grant the caller was given.
deviceRoutes.post('/:deviceId/record', requireDeviceAccess, takeRecordingTurn);
deviceRoutes.delete('/:deviceId/record', requireDeviceAccess, releaseRecordingTurn);
deviceRoutes.post('/:deviceId/recordings', requireDeviceAccess, createRecording);
deviceRoutes.post('/:deviceId/recordings/:eventId/confirm', requireDeviceAccess, confirmRecording);

// Live view and talk. All three are membership-gated by
// requireDeviceAccess, which is half of what makes removing someone
// revoke their access immediately - the other half is that the token
// they already hold expires in two minutes.
deviceRoutes.post('/:deviceId/live', requireDeviceAccess, getViewerToken);
deviceRoutes.post('/:deviceId/talk', requireDeviceAccess, takeTalk);
deviceRoutes.delete('/:deviceId/talk', requireDeviceAccess, releaseTalk);
