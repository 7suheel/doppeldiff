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
  entryPoints: { index: 'src/index.ts', cli: 'src/bin.ts' },
  outdir: 'dist',
  packages: 'external',
});

await esbuild.build({
  ...common,
  entryPoints: { child: 'src/core/runner/child.ts' },
  outdir: 'dist',
});

// GitHub Action entry: bundles the Actions toolkit and the optional LLM SDKs; runtime dependencies stay
// external and are installed by the composite action (`npm ci --omit=dev`). The output is committed.
if (process.argv.includes('--action')) {
  const { readFileSync, copyFileSync, mkdirSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  mkdirSync('action/dist', { recursive: true });
  await esbuild.build({
    ...common,
    sourcemap: false,
    minify: true,
    entryPoints: { main: 'src/action/main.ts' },
    outdir: 'action/dist',
    external: Object.keys(pkg.dependencies ?? {}),
    banner: {
      js: "import { createRequire as __ddRequire } from 'node:module'; const require = __ddRequire(import.meta.url);",
    },
    legalComments: 'linked',
  });
  copyFileSync('dist/child.js', 'action/dist/child.js');
}
