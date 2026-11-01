#!/usr/bin/env node
import { main } from './cli.js';

/** Exit only after stdout has been flushed (large JSON reports to a pipe would otherwise be truncated). */
function exit(code: number): void {
  process.exitCode = code;
  process.stdout.write('', () => process.exit(code));
}

main().then(exit, (e: unknown) => {
  process.stderr.write(`doppeldiff: ${(e as Error).message}\n`);
  exit(2);
});
