import path from 'node:path';
import { defineConfig } from 'vite';
import { isolateRenderRng } from './scripts/isolate-render-rng.mjs';

// Only build.mjs supplies a validated run. Direct `vite build` must not choose an output implicitly.
export function createScene3dConfig(record, { outDir = record.releaseDir } = {}) {
  if (!record?.projectRoot || !record?.buildId || !path.isAbsolute(outDir)) throw new Error('Validated absolute run configuration required');
  const root = path.join(record.projectRoot, 'scene3d');
  return {
    root,
    configFile: false,
    base: './',
    publicDir: false,
    plugins: [isolateRenderRng({ projectRoot: record.projectRoot })],
    build: {
      outDir,
      emptyOutDir: false,
      manifest: false,
      sourcemap: false,
      target: 'es2022',
      minify: false,
      cssCodeSplit: false,
      lib: { entry: path.join(root, 'src', 'index.js'), formats: ['es'], fileName: () => 'entry.mjs', cssFileName: 'scene3d' },
      rolldownOptions: {
        preserveEntrySignatures: 'strict',
        output: { chunkFileNames: 'chunks/[name]-[hash].mjs', assetFileNames: 'bundled/[name]-[hash][extname]' }
      }
    }
  };
}
export default defineConfig(() => { throw new Error('Use node scripts/build.mjs --runRecord=<absolute run.json>; direct Vite invocation is prohibited'); });
