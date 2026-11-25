// Rewrites cases.json from the current summarizer. Review `git diff test/golden/cases.json`
// line by line before committing: every changed line is a change in what users hear.
import { writeFileSync } from 'node:fs';
import { summarize } from '../../src/daemon/summarizer/rules.mjs';
import { INPUTS } from './inputs.mjs';

const cases = INPUTS.map(([name, mode, input]) => ({ name, mode, expected: summarize(input, { mode, elapsedMs: 30_000 }) }));
writeFileSync(new URL('./cases.json', import.meta.url), JSON.stringify(cases, null, 2) + '\n');
console.log(`wrote ${cases.length} cases`);
