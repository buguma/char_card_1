import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export function assert(condition, message) { if (!condition) throw new Error(message); }
export function safeRelative(name) {
  assert(typeof name === 'string' && name.length > 0, 'Expected nonempty relative path');
  assert(!/[\\:%?#\u0000-\u001f\u007f]/u.test(name) && !name.startsWith('/'), `Unsafe path: ${name}`);
  for (const part of name.split('/')) {
    assert(part && part !== '.' && part !== '..' && !/[. ]$/.test(part), `Unsafe path: ${name}`);
    assert(!/[<>"|*]/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part), `Nonportable path: ${name}`);
  }
  return name;
}
export function uniquePaths(names) {
  const seen = new Map();
  for (const name of names) {
    safeRelative(name);
    const parts = name.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const key = prefix.normalize('NFC').toLowerCase();
      assert(!seen.has(key) || seen.get(key) === prefix, `Case/Unicode collision: ${prefix}`);
      seen.set(key, prefix);
    }
  }
  const set = new Set(names);
  for (const name of names) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) assert(!set.has(parts.slice(0, i).join('/')), `File/directory collision: ${name}`);
  }
}
export function absolute(value, label = 'path') {
  assert(typeof value === 'string' && path.isAbsolute(value), `${label} must be absolute`);
  assert(path.normalize(value) === value && !value.split(/[\\/]/).includes('..'), `${label} must be normalized`);
  return value;
}
export function inside(root, target, allowRoot = false) {
  const rel = path.relative(root, target);
  assert((allowRoot || rel !== '') && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel), `Path escapes root: ${target}`);
  return target;
}
// Reject all symlinks (including in existing ancestors), not just escaping links.
export async function noSymlinks(target) {
  absolute(target);
  const parsed = path.parse(target);
  let cursor = parsed.root;
  for (const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { const stat = await fs.lstat(cursor); assert(!stat.isSymbolicLink(), `Symlink prohibited: ${cursor}`); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
}
export async function exists(target) {
  try { await fs.lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function readJson(target) { await noSymlinks(target); return JSON.parse(await fs.readFile(target, 'utf8')); }
export async function atomicJson(target, value, { exclusive = false } = {}) {
  await noSymlinks(target);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (exclusive) { await fs.writeFile(target, jsonBytes(value), { flag: 'wx' }); return; }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(jsonBytes(value)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}
export async function fileInfo(target) {
  await noSymlinks(target);
  assert((await fs.lstat(target)).isFile(), `Not a regular file: ${target}`);
  const bytes = await fs.readFile(target);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}
export function validateFiles(files) {
  assert(files && typeof files === 'object' && !Array.isArray(files), 'Missing files object');
  uniquePaths(Object.keys(files));
  for (const [name, meta] of Object.entries(files)) {
    assert(meta && Number.isSafeInteger(meta.bytes) && meta.bytes >= 0 && /^[a-f0-9]{64}$/.test(meta.sha256), `Invalid metadata: ${name}`);
  }
}
export async function walkFiles(root) {
  await noSymlinks(root);
  assert((await fs.lstat(root)).isDirectory(), `Not a directory: ${root}`);
  const result = [];
  async function walk(dir, prefix) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const item of entries) {
      const name = prefix ? `${prefix}/${item.name}` : item.name;
      safeRelative(name);
      assert(!item.isSymbolicLink(), `Symlink prohibited: ${name}`);
      if (item.isDirectory()) await walk(path.join(dir, item.name), name);
      else { assert(item.isFile(), `Not regular file: ${name}`); result.push(name); }
    }
  }
  await walk(root, ''); uniquePaths(result); return result.sort();
}
export async function verifyFiles(root, files, extraNames = []) {
  validateFiles(files);
  const expected = [...Object.keys(files), ...extraNames].sort(); uniquePaths(expected);
  const actual = await walkFiles(root);
  assert(JSON.stringify(actual) === JSON.stringify(expected), `File set mismatch in ${root}: expected ${expected.join(', ')}, actual ${actual.join(', ')}`);
  for (const [name, meta] of Object.entries(files)) {
    const actualMeta = await fileInfo(path.join(root, ...name.split('/')));
    assert(actualMeta.bytes === meta.bytes && actualMeta.sha256 === meta.sha256, `Byte/hash mismatch: ${name}`);
  }
}
export function validateManifest(manifest, expectedBuildId) {
  assert(manifest?.schemaVersion === 1 && manifest.buildId === expectedBuildId, 'Manifest build/schema mismatch');
  safeRelative(manifest.buildId); assert(!manifest.buildId.includes('/'), 'Invalid buildId');
  assert(manifest.bridgeProtocol?.min === 1 && manifest.bridgeProtocol?.max === 1, 'Unsupported bridge protocol');
  validateFiles(manifest.files);
  assert(!Object.hasOwn(manifest.files, 'manifest.json'), 'Manifest cannot hash itself');
  assert(typeof manifest.entry === 'string' && /\.m?js$/.test(manifest.entry) && Object.hasOwn(manifest.files, manifest.entry), 'Missing ESM entry');
  assert(Array.isArray(manifest.css) && new Set(manifest.css).size === manifest.css.length, 'Invalid CSS list');
  for (const css of manifest.css) assert(typeof css === 'string' && css.endsWith('.css') && Object.hasOwn(manifest.files, css), `Missing CSS: ${css}`);
  return manifest;
}
export async function verifyRelease(root, expectedBuildId, expectedHash) {
  const info = await fileInfo(path.join(root, 'manifest.json'));
  if (expectedHash) assert(info.sha256 === expectedHash, 'Manifest hash mismatch');
  const manifest = validateManifest(await readJson(path.join(root, 'manifest.json')), expectedBuildId);
  await verifyFiles(root, manifest.files, ['manifest.json']);
  return { manifest, manifestSha256: info.sha256 };
}
export async function copyFiles(source, destination, files) {
  validateFiles(files); await noSymlinks(destination);
  for (const name of Object.keys(files)) {
    const from = path.join(source, ...name.split('/')), to = path.join(destination, ...name.split('/'));
    await noSymlinks(from); await noSymlinks(to);
    const info = await fileInfo(from);
    assert(info.sha256 === files[name].sha256 && info.bytes === files[name].bytes, `Source changed: ${name}`);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to, 1 /* COPYFILE_EXCL */);
  }
}
