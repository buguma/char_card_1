/**
 * Build the reviewed Web→APK mapping in an explicitly prepared, same-run copy.
 * Usage (inside <run>/apk-copy/apk): node build.js --runRecord=<absolute run.json>
 * No argument-free fallback: changing cwd must never overwrite the source apk/www.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  const scripts = path.join(__dirname, '..', 'scene3d', 'scripts');
  const { withRun } = await import(pathToFileURL(path.join(scripts, 'run-record.mjs')).href);
  const { buildApkWww } = await import(pathToFileURL(path.join(scripts, 'prepare-apk.mjs')).href);
  const result = await withRun('apk:www', (record, context) => buildApkWww(record, context, __dirname));
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
