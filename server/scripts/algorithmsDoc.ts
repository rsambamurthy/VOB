/** Writes docs/ALGORITHMS.md from the algorithm definitions (npm run -w server docs:algorithms). tests/algorithms.test.ts checks it is current. */
import fs from 'node:fs';
import path from 'node:path';
import { algorithmsMarkdown } from '../src/lib/algorithms.js';
import '../src/services/invoices/duplicates.js';
import '../src/services/invoices/inbox.js';

const out = path.resolve(import.meta.dirname, '../../docs/ALGORITHMS.md');
fs.writeFileSync(out, algorithmsMarkdown() + '\n');
console.log(`Wrote ${out}`);
process.exit(0);
