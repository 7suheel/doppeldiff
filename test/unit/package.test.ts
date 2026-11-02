import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  bin: Record<string, string>;
};

describe('package.json', () => {
  it('declares the CLI in a form npm publishes unchanged', () => {
    // npm 11 drops `bin` entries written as "./dist/cli.js" when publishing ("script name ... was invalid and
    // removed"), which would ship a package without the `doppeldiff` command.
    expect(Object.keys(pkg.bin)).toEqual(['doppeldiff']);
    for (const target of Object.values(pkg.bin)) {
      expect(target).not.toMatch(/^\.\.?\//);
      expect(target).toBe('dist/cli.js');
    }
    expect(existsSync(new URL('../../scripts/build.mjs', import.meta.url))).toBe(true);
  });
});
