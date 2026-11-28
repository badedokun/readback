#!/usr/bin/env node
// Stand-in for `claude -p` in summarizer tests. Behaviour comes from FAKE_CLAUDE:
//   echo:<text>  print <text>      sleep:<ms>  hang      fail  exit 1
//   args:<file>  write argv, env flag, stdin and cwd to <file> as JSON, then print "Done."
import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const [mode, ...rest] = String(process.env.FAKE_CLAUDE ?? '').split(':');
  const arg = rest.join(':');
  if (mode === 'echo') process.stdout.write(arg);
  else if (mode === 'sleep') setTimeout(() => process.stdout.write('late'), Number(arg));
  else if (mode === 'fail') process.exit(1);
  else if (mode === 'args') {
    writeFileSync(arg, JSON.stringify({ argv: process.argv.slice(2), disable: process.env.READBACK_DISABLE, input, cwd: process.cwd() }));
    process.stdout.write('Done.');
  }
});
