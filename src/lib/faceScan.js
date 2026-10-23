/*
 * The arithmetic of the face scan, apart from the screen that shows it: where
 * the head is pointing, which of the photos worth keeping a frame would be,
 * and whether it is any good. See components/FaceScan.jsx.
 *
 * What the doorbell needs from the scan is a face it can match at the door:
 * mostly straight on, turned a little each way, sharp, lit, eyes open. So the
 * scan keeps one picture looking straight at the camera and one for each of
 * eight directions, turned 10 to 28 degrees - further than that and the
 * picture is of a face the doorbell, mounted at head height, will never see.
 */

export const SECTORS = 8;
export const TICKS = 36;

// Degrees from looking straight at the camera.
export const STRAIGHT_UNDER = 7; // counts as straight on
export const TURN_FROM = 10; // a turned photo, from here...
export const TURN_TO = 28; // ...to here
export const TICK_AT = 14; // lights the ring
export const TOO_FAR = 40; // asks for a gentler circle
// Further than this either way and the face is not looking at the screen,
// which is what finding its "straight ahead" needs.
export const STRAIGHT_YAW_LIMIT = 15;

// The face's size in the camera's frame, as a fraction of its shorter side.
export const FACE_MIN = 0.22;
export const FACE_MAX = 0.75;

export const PHOTO_SIZE = 256;
// The square around the face is this many times the face's width, so the
// doorbell's own face finder has the whole head and some background to go on.
const CROP_FACTOR = 2;

const DEG = 180 / Math.PI;

/**
 * Where a face is, in the camera's own pixels, and which way it points, in
 * degrees: `yaw` positive with the nose towards the right of the camera's
 * picture, `pitch` positive looking down. Null without the rotation.
 *
 * The angles are from Face Landmarker's facial transformation matrix - the
 * head's rotation in 3-D, from its own geometry. Reading them off where the
 * nose sits between the cheeks came out two and a half times too large
 * against it, on photos turned 6 to 66 degrees. The signs were checked
 * against the nose the same way.
 *
 * Straight ahead is not zero: the camera is seldom level with the eyes. See
 * `turn`, which takes off what this face's straight ahead turned out to be.
 */
export function measureFace(landmarks, matrix, width, height) {
  const m = matrix?.data;
  if (!m) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of landmarks) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  return {
    yaw: Math.atan2(m[8], m[10]) * DEG,
    pitch: Math.asin(Math.max(-1, Math.min(1, -m[9]))) * DEG,
    box: {
      x: minX * width,
      y: minY * height,
      w: (maxX - minX) * width,
      h: (maxY - minY) * height
    }
  };
}

/**
 * The turn of the head away from straight ahead, as the person sees it in
 * the mirrored preview: `dx` positive is towards the right of the screen,
 * `dy` positive is down. `degrees` is how far, `angle` which way round the
 * circle, in radians from the right, clockwise on screen.
 */
export function turn(face, straight) {
  // The preview is a mirror, so the camera's right is the screen's left.
  const dx = -(face.yaw - straight.yaw);
  const dy = face.pitch - straight.pitch;
  return { dx, dy, degrees: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) };
}

/** Which tick of the ring a direction lights. */
export function tickOf(angle) {
  const turnFraction = (angle + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI);
  return Math.round(turnFraction * TICKS) % TICKS;
}

/** Which of the eight turned photos a direction is, 0 being to the right. */
export function sectorOf(angle) {
  const turnFraction = (angle + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI);
  return Math.round(turnFraction * SECTORS) % SECTORS;
}

/** The square the photo is cut from, in camera pixels, or null if it would
 * run off the frame - a face half out of the picture is not worth keeping. */
export function cropSquare(box, width, height) {
  const side = Math.min(CROP_FACTOR * Math.max(box.w, box.h), width, height);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const x = Math.round(Math.min(Math.max(cx - side / 2, 0), width - side));
  const y = Math.round(Math.min(Math.max(cy - side / 2, 0), height - side));
  const inside =
    box.x >= x && box.y >= y && box.x + box.w <= x + side && box.y + box.h <= y + side;
  return inside ? { x, y, side: Math.round(side) } : null;
}

/**
 * How sharp and how bright a small grey picture of the face is: the variance
 * of its Laplacian, the usual measure of focus - a blurred frame has no hard
 * edges - and its mean brightness out of 255. `pixels` is RGBA, from
 * getImageData.
 */
export function judgePixels(pixels, size) {
  const grey = new Float32Array(size * size);
  let sum = 0;
  for (let i = 0; i < size * size; i += 1) {
    const value = 0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2];
    grey[i] = value;
    sum += value;
  }
  let lapSum = 0;
  let lapSquares = 0;
  let count = 0;
  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const i = y * size + x;
      const lap = grey[i - 1] + grey[i + 1] + grey[i - size] + grey[i + size] - 4 * grey[i];
      lapSum += lap;
      lapSquares += lap * lap;
      count += 1;
    }
  }
  const mean = lapSum / count;
  return { sharpness: lapSquares / count - mean * mean, brightness: sum / (size * size) };
}

/** Both eyes open, from Face Landmarker's blendshapes: a blink matches nobody. */
export function eyesOpen(blendshapes) {
  const categories = blendshapes?.categories;
  if (!categories) return true; // not measured is not closed
  const score = (name) => categories.find((c) => c.categoryName === name)?.score ?? 0;
  return score('eyeBlinkLeft') < 0.45 && score('eyeBlinkRight') < 0.45;
}

/**
 * The photos to send, best first: straight on from both passes, every
 * direction from the first, and the sharpest few of the second - at most
 * `limit`. `passes` is two arrays of { bucket, sharpness, canvas }, where
 * bucket is "straight" or a sector number.
 */
export function choosePhotos(passes, limit) {
  const [first = [], second = []] = passes;
  const straight = [...first, ...second].filter((p) => p.bucket === 'straight');
  const turned = first.filter((p) => p.bucket !== 'straight');
  const extra = second
    .filter((p) => p.bucket !== 'straight')
    .sort((a, b) => b.sharpness - a.sharpness);
  return [...straight, ...turned, ...extra].slice(0, Math.max(0, limit));
}
