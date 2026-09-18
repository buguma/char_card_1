import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, exists, noSymlinks, verifyRelease, copyFiles, atomicJson, fileInfo } from './artifact-utils.mjs';
import { withRun, requireStep, isMain, runCli } from './run-record.mjs';

export async function publishAssets(record) {
  const built = requireStep(record, 'build');
  assert(built.releaseDir === record.releaseDir, 'Build belongs to another release');
  const { manifest, manifestSha256 } = await verifyRelease(record.releaseDir, record.buildId, built.manifestSha256);
  await noSymlinks(record.publishRoot); await fs.mkdir(record.publishRoot, { recursive: true });
  const lockPath = path.join(record.publishRoot, '.publish.lock'); await noSymlinks(lockPath);
  const lock = await fs.open(lockPath, 'wx');
  try {
    const versionRoot = path.join(record.publishRoot, record.buildId);
    await noSymlinks(versionRoot);
    if (await exists(versionRoot)) {
      // Idempotent exact same bytes only. Different bytes under one buildId are never overwritten.
      await verifyRelease(versionRoot, record.buildId, manifestSha256);
    } else {
      const stage = path.join(record.publishRoot, `.stage-${record.buildId}-${record.runId}`);
      await noSymlinks(stage); assert(!await exists(stage), 'Partial publish stage exists; explicit review required');
      await fs.mkdir(stage);
      await copyFiles(record.releaseDir, stage, manifest.files);
      await fs.copyFile(path.join(record.releaseDir, 'manifest.json'), path.join(stage, 'manifest.json'), 1);
      await verifyRelease(stage, record.buildId, manifestSha256);
      await fs.rename(stage, versionRoot);
      await verifyRelease(versionRoot, record.buildId, manifestSha256);
    }
    // Recheck the upstream release before committing the only mutable public pointer.
    await verifyRelease(record.releaseDir, record.buildId, manifestSha256);
    const pointer = { schemaVersion: 1, buildId: record.buildId, bridgeProtocol: { min: 1, max: 1 }, manifest: `${record.buildId}/manifest.json`, manifestSha256 };
    await atomicJson(path.join(record.publishRoot, 'current.json'), pointer);
    return { versionRoot, manifestSha256, pointerSha256: (await fileInfo(path.join(record.publishRoot, 'current.json'))).sha256 };
  } finally { await lock.close(); await fs.unlink(lockPath); }
}
if (isMain(import.meta.url)) runCli(() => withRun('publish:assets', publishAssets));
