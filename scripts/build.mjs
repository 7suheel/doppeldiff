// Bundles the package with esbuild. Dependencies stay external; the runner child is bundled
// self-contained because it runs under the Node permission model.
import { rmSync } from 'node:fs';
import * as esbuild from 'esbuild';

rmSync('dist', { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
};

await esbuild.build({
  ...common,
  entryPoints: { index: 'src/index.ts' },
  outdir: 'dist',
  packages: 'external',
});

await esbuild.build({
  ...common,
  entryPoints: { child: 'src/core/runner/child.ts' },
  outdir: 'dist',
});
