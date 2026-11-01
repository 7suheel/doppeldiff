/** Writes schema/report.schema.json from the zod report model. Usage: npm run schema */
import { mkdirSync, writeFileSync } from 'node:fs';
import { reportJsonSchema } from '../src/core/report/model.js';

mkdirSync('schema', { recursive: true });
writeFileSync('schema/report.schema.json', `${JSON.stringify(reportJsonSchema(), null, 2)}\n`);
console.log('wrote schema/report.schema.json');
