/*
 * MediaPipe's WebAssembly, copied out of node_modules into public/ before
 * every dev server and build, so the face scan loads it from this site and
 * not from a CDN: the CSP allows scripts from 'self' only, and a scan that
 * depended on a third party being up would fail in the one moment it is used.
 *
 * Copied rather than committed: two variants of 11 MB each, and they must
 * match the package version in package-lock.json exactly - the loader script
 * and the .wasm are built together. The face model, which is not in the
 * package, is committed beside them in public/mediapipe/.
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const to = join(root, 'public', 'mediapipe', 'wasm');

// The two that FilesetResolver.forVisionTasks() picks between - with SIMD,
// and without for the browsers that lack it. The "module" pair is for
// useModule, which this app does not use.
const wanted = /^vision_wasm(_nosimd)?_internal\.(js|wasm)$/;

mkdirSync(to, { recursive: true });
const files = readdirSync(from).filter((name) => wanted.test(name));
if (files.length !== 4) {
  throw new Error(`expected 4 MediaPipe wasm files in ${from}, found ${files.length}`);
}
for (const name of files) copyFileSync(join(from, name), join(to, name));
console.log(`copy-mediapipe: ${files.length} files to public/mediapipe/wasm`);
