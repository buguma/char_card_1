import path from 'node:path';
import { assert, readJson, verifyRelease, atomicJson, fileInfo } from './artifact-utils.mjs';
import { withRun, requireStep, isMain, runCli } from './run-record.mjs';

export async function verifyWeb(record, { runDir }) {
  const built = requireStep(record, 'build');
  assert(built.releaseDir === record.releaseDir, 'Build release path mismatch');
  const verified = await verifyRelease(record.releaseDir, record.buildId, built.manifestSha256);
  const checks = [{ kind: 'release', root: record.releaseDir, manifestSha256: verified.manifestSha256 }];
  if (record.steps?.['publish:assets']) {
    const published = requireStep(record, 'publish:assets');
    const pointerPath = path.join(record.publishRoot, 'current.json');
    const pointer = await readJson(pointerPath);
    assert(pointer.schemaVersion === 1 && pointer.buildId === record.buildId, 'Pointer run/build mismatch');
    assert(pointer.bridgeProtocol?.min === 1 && pointer.bridgeProtocol?.max === 1, 'Pointer protocol mismatch');
    assert(pointer.manifest === `${record.buildId}/manifest.json` && pointer.manifestSha256 === built.manifestSha256, 'Pointer manifest mismatch');
    assert((await fileInfo(pointerPath)).sha256 === published.pointerSha256, 'Published pointer changed');
    const versionRoot = path.join(record.publishRoot, record.buildId);
    assert(published.versionRoot === versionRoot, 'Published version root mismatch');
    await verifyRelease(versionRoot, record.buildId, built.manifestSha256);
    checks.push({ kind: 'published', root: versionRoot, manifestSha256: built.manifestSha256 });
  }
  const reportPath = path.join(runDir, 'verify-web.json');
  const report = { schemaVersion: 1, buildId: record.buildId, status: 'passed', verifiedAt: new Date().toISOString(), checks, scope: 'Exact local version file sets and bytes only; not renderer/browser/APK acceptance' };
  await atomicJson(reportPath, report);
  return { reportPath, reportSha256: (await fileInfo(reportPath)).sha256, checks };
}
if (isMain(import.meta.url)) runCli(() => withRun('verify:web', verifyWeb));
