// Generates the Readback architecture diagrams as SVG, then renders PNGs.
// Usage: node docs/diagrams/src/build.mjs   (needs rsvg-convert for PNGs)
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..');
const C = {
  ink: '#1f2328', quiet: '#57606a', edge: '#8c959f', grid: '#d0d7de',
  accent: '#2f6feb', accentFill: '#eaf2ff', bg: '#ffffff', band: '#f6f8fa',
  warn: '#9a6700', warnFill: '#fff8e5',
};
const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const HALO = 'stroke="#ffffff" stroke-width="4" stroke-linejoin="round" paint-order="stroke"';

function doc(w, h, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}" role="img" aria-label="${esc(title)}">
<defs>
<marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${C.edge}"/></marker>
<marker id="arrA" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${C.accent}"/></marker>
</defs>
<rect width="100%" height="100%" fill="${C.bg}"/>
<text x="24" y="36" font-size="18" font-weight="600" fill="${C.ink}">${esc(title)}</text>
${body}
</svg>
`;
}

function box(x, y, w, h, title, lines = [], o = {}) {
  const stroke = o.accent ? C.accent : o.warn ? C.warn : C.edge;
  const fill = o.accent ? C.accentFill : o.warn ? C.warnFill : C.bg;
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="${o.accent ? 2 : 1.25}"${o.dashed ? ' stroke-dasharray="5 4"' : ''}/>`;
  const tx = o.center ? x + w / 2 : x + 12;
  const anchor = o.center ? 'middle' : 'start';
  s += `<text x="${tx}" y="${y + 24}" font-size="14" font-weight="600" fill="${C.ink}" text-anchor="${anchor}">${esc(title)}</text>`;
  lines.forEach((l, i) => {
    s += `<text x="${tx}" y="${y + 44 + i * 17}" font-size="12.5" fill="${C.quiet}" text-anchor="${anchor}">${esc(l)}</text>`;
  });
  return s;
}

function container(x, y, w, h, title) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${C.band}" stroke="${C.grid}" stroke-width="1.25" stroke-dasharray="6 4"/>` +
    `<text x="${x + 14}" y="${y + 22}" font-size="13" font-weight="600" fill="${C.quiet}">${esc(title)}</text>`;
}

function line(d, o = {}) {
  const m = o.accent ? 'arrA' : 'arr';
  return `<path d="${d}" fill="none" stroke="${o.accent ? C.accent : C.edge}" stroke-width="1.4"${o.dashed ? ' stroke-dasharray="5 4"' : ''}${o.noHead ? '' : ` marker-end="url(#${m})"`}${o.both ? ` marker-start="url(#${m})"` : ''}/>`;
}

function label(x, y, t, o = {}) {
  return `<text x="${x}" y="${y}" font-size="12" fill="${o.color || C.quiet}" text-anchor="${o.anchor || 'start'}" ${HALO}>${esc(t)}</text>`;
}

// ---------- 1. System context ----------
function systemContext() {
  let b = '';
  b += line('M135 230V108H360') + label(248, 100, 'prompts (/voice or keyboard)', { anchor: 'middle' });
  b += line('M450 146V230') + label(442, 194, 'hook events (JSON on stdin)', { anchor: 'end' });
  b += line('M530 230V146', { accent: true }) + label(538, 194, 'permission decision', { color: C.accent });
  b += line('M640 270H750') + label(695, 262, 'speech', { anchor: 'middle' });
  b += line('M750 305H640') + label(695, 322, 'yes / no', { anchor: 'middle' });
  b += line('M840 340V382H135V340', { both: true }) + label(150, 376, 'hears speech · speaks answers');
  b += line('M420 340V410', { dashed: true });
  b += line('M590 340V410', { dashed: true });
  b += line('M640 330H740V445H750');
  b += box(360, 70, 260, 76, 'Claude Code CLI', ['fires hook events', 'shows permission dialogs']);
  b += box(340, 230, 300, 110, 'Readback plugin', ['hook shims + local daemon', 'summarize · speak · listen for yes/no'], { accent: true });
  b += box(40, 230, 190, 110, 'Developer', ['talks via /voice', 'hears summaries', 'answers prompts by voice']);
  b += box(750, 230, 180, 110, 'Audio devices', ['speakers: speech out', 'mic: yes/no answers']);
  b += box(250, 410, 230, 70, 'Claude Haiku (optional)', ['via claude -p, your login'], { dashed: true });
  b += box(500, 410, 230, 70, 'Cloud TTS (opt-in)', ['OpenAI / ElevenLabs'], { dashed: true });
  b += box(750, 410, 180, 70, 'Local models', ['Piper voices', 'whisper.cpp tiny.en']);
  b += label(24, 520, 'Dashed = optional, off by default. With defaults nothing leaves the machine.');
  return doc(960, 540, 'Readback system context: a local layer between Claude Code and your ears', b);
}

// ---------- 2. Components ----------
function components() {
  let b = '';
  b += container(24, 60, 290, 520, 'Hook shims (one short process per event)');
  b += container(344, 60, 672, 520, 'Readback daemon (one per machine, JSON over Unix socket)');
  const ev = [
    ['SessionStart', 'start daemon if not running'],
    ['Stop (async)', 'send last_assistant_message'],
    ['Notification (async)', 'idle / permission alerts'],
    ['PermissionRequest (sync)', 'wait for decision ≤ 30 s'],
    ['UserPromptSubmit (sync)', 'stop speech; run /readback:*'],
    ['SessionEnd (async)', 'stop daemon if last session'],
  ];
  ev.forEach(([t, l], i) => {
    const y = 100 + i * 80;
    b += line(`M284 ${y + 30}H314`, { noHead: true });
    b += box(44, y, 240, 60, t, [l], { accent: t.startsWith('PermissionRequest') });
  });
  b += line('M314 130V530', { noHead: true });
  b += line('M314 310H364');
  // daemon internals
  b += line('M444 265V145H564');
  b += line('M764 145H804');
  b += line('M764 290H784V170H804');
  b += line('M524 310H564', { both: true, accent: true });
  b += line('M804 395H784V330H764', { accent: true });
  b += line('M900 190V225');
  b += line('M996 265H1006V596H951V612');
  b += line('M849 612V440', { accent: true });
  b += box(364, 265, 160, 90, 'IPC server', ['Unix socket', 'request / reply']);
  b += box(564, 100, 200, 90, 'Summarizer', ['rules | claude-haiku', 'applies speech rules']);
  b += box(564, 265, 200, 90, 'Permission broker', ['never_by_voice gate', 'timeout → fallback'], { accent: true });
  b += box(564, 430, 200, 76, 'Config', ['config.toml + project file', 'read by every part']);
  b += box(804, 100, 192, 90, 'Speech queue', ['permission prompts first', 'dedupe 60 s · newest wins']);
  b += box(804, 225, 192, 80, 'TTS adapter', ['say · piper · kokoro', 'espeak · cloud (opt-in)']);
  b += box(804, 350, 192, 90, 'Answer listener', ['whisper.cpp tiny.en', 'yes / no / show me, 20 s'], { accent: true });
  b += box(906, 612, 90, 44, 'Speakers', [], { center: true });
  b += box(804, 612, 90, 44, 'Mic', [], { center: true });
  b += label(24, 690, 'Blue = the voice-approval path. The daemon is the only long-lived process; shims exit immediately except PermissionRequest.');
  return doc(1040, 710, 'Readback components: thin hook shims, one local daemon', b);
}

// ---------- sequence diagram engine ----------
function sequence({ title, w, parts, steps, caption }) {
  const left = 40, top = 60, headW = 160, headH = 46, rowH = 38;
  const gap = (w - 2 * left - headW) / (parts.length - 1);
  const X = {};
  parts.forEach((p, i) => { X[p.id] = left + headW / 2 + i * gap; });
  let y = top + headH + 34;
  let n = 0;
  let back = '', front = '';

  const render = (list) => {
    for (const s of list) {
      if (s.frame) {
        const y0 = y - 22;
        y += 26;
        const divs = [];
        s.sections.forEach((sec, i) => {
          if (i > 0) { divs.push({ y: y - 22, label: sec.label }); y += 24; }
          else front += label(left + 62, y0 + 16, `[${sec.label}]`);
          render(sec.steps);
        });
        const y1 = y - 14;
        back += `<rect x="${left - 16}" y="${y0}" width="${w - 2 * left + 32}" height="${y1 - y0}" rx="4" fill="none" stroke="${C.grid}" stroke-width="1.25"/>`;
        back += `<path d="M${left - 16} ${y0 + 22}H${left + 30}L${left + 40} ${y0 + 12}V${y0}" fill="${C.band}" stroke="${C.grid}"/>`;
        front += `<text x="${left - 8}" y="${y0 + 16}" font-size="12" font-weight="600" fill="${C.ink}">${esc(s.frame)}</text>`;
        divs.forEach((d) => {
          back += `<path d="M${left - 16} ${d.y}H${w - left + 16}" stroke="${C.grid}" stroke-dasharray="5 4"/>`;
          front += label(left + 62, d.y + 16, `[${d.label}]`);
        });
        y += 18;
        continue;
      }
      if (s.note) {
        const tw = s.note.length * 6.6 + 24;
        const cx = X[s.at];
        front += `<rect x="${cx - tw / 2}" y="${y - 18}" width="${tw}" height="26" rx="6" fill="${C.warnFill}" stroke="${C.warn}" stroke-width="1"/>`;
        front += `<text x="${cx}" y="${y}" font-size="12" fill="${C.ink}" text-anchor="middle">${esc(s.note)}</text>`;
        y += rowH;
        continue;
      }
      n += 1;
      const x1 = X[s.from], x2 = X[s.to];
      const dir = x2 > x1 ? -1 : 1;
      front += line(`M${x1} ${y}H${x2 + dir * 2}`, { dashed: s.dashed, accent: s.accent });
      front += label((x1 + x2) / 2, y - 7, `${n}. ${s.t}`, { anchor: 'middle', color: s.accent ? C.accent : C.ink });
      y += rowH;
    }
  };
  render(steps);
  const bottom = y + 6;
  let heads = '';
  parts.forEach((p) => {
    heads += `<path d="M${X[p.id]} ${top + headH}V${bottom}" stroke="${C.grid}" stroke-width="1.25" stroke-dasharray="4 4"/>`;
    heads += box(X[p.id] - headW / 2, top, headW, headH, p.name, [], { center: true, accent: p.accent });
  });
  const h = bottom + (caption ? 44 : 24);
  const cap = caption ? label(24, bottom + 28, caption) : '';
  return doc(w, h, title, heads + back + front + cap);
}

function turnEnd() {
  return sequence({
    title: 'Turn end: Claude finishes, Readback speaks two sentences; any prompt stops it',
    w: 1100,
    parts: [
      { id: 'dev', name: 'Developer' }, { id: 'cc', name: 'Claude Code' },
      { id: 'hook', name: 'Hook shims' }, { id: 'd', name: 'Readback daemon', accent: true },
      { id: 'a', name: 'Speakers' },
    ],
    steps: [
      { from: 'dev', to: 'cc', t: 'prompt (dictated with /voice)' },
      { note: 'works: tools run, Readback stays silent', at: 'cc' },
      { from: 'cc', to: 'hook', t: 'Stop {last_assistant_message}' },
      { from: 'hook', to: 'd', t: 'speak.turn(message, elapsed)' },
      { from: 'hook', to: 'cc', t: 'exit 0 (< 50 ms)', dashed: true },
      { note: 'summarize with the speech rules', at: 'd' },
      { from: 'd', to: 'a', t: 'play summary' },
      { from: 'a', to: 'dev', t: 'hears ≤ 2 sentences', dashed: true },
      { frame: 'opt', sections: [{ label: 'developer interrupts', steps: [
        { from: 'dev', to: 'cc', t: '/readback:stop (or any prompt)' },
        { from: 'cc', to: 'hook', t: 'UserPromptSubmit' },
        { from: 'hook', to: 'd', t: 'stop()' },
        { from: 'd', to: 'a', t: 'stop playback (< 150 ms)' },
        { from: 'hook', to: 'cc', t: 'block: not sent to Claude', dashed: true },
      ] }] },
    ],
    caption: 'Example summary: "Added a rate limiter to the login route. Tests pass. Want me to commit?"  Step 11 applies to /readback:* commands only; normal prompts continue to Claude.',
  });
}

function voicePermission() {
  return sequence({
    title: 'Voice approval: every failure path falls back to the normal keyboard dialog',
    w: 1100,
    parts: [
      { id: 'dev', name: 'Developer' }, { id: 'cc', name: 'Claude Code' },
      { id: 'hook', name: 'Permission hook' }, { id: 'd', name: 'Readback daemon', accent: true },
      { id: 'a', name: 'Speaker / mic' },
    ],
    steps: [
      { from: 'cc', to: 'hook', t: 'PermissionRequest {tool, input}' },
      { from: 'hook', to: 'd', t: 'permission.ask (hook waits)' },
      { frame: 'alt', sections: [
        { label: 'matches never_by_voice', steps: [
          { from: 'd', to: 'a', t: 'say "needs the keyboard"' },
          { from: 'd', to: 'hook', t: 'no decision', dashed: true },
          { from: 'hook', to: 'cc', t: 'exit 0, no output → dialog', dashed: true },
        ] },
        { label: 'voice-eligible', steps: [
          { from: 'd', to: 'a', t: 'speak the request' },
          { note: 'e.g. "Claude wants to run npm test. Allow?"', at: 'd' },
          { from: 'a', to: 'dev', t: 'hears the request', dashed: true },
          { note: 'listener opens after playback ends (20 s window)', at: 'd' },
          { from: 'dev', to: 'a', t: '"allow"', accent: true },
          { from: 'a', to: 'd', t: 'transcript + confidence', accent: true },
          { from: 'd', to: 'hook', t: 'allow (this request only)', accent: true },
          { from: 'hook', to: 'cc', t: 'behavior: "allow"', accent: true },
          { from: 'd', to: 'a', t: 'confirmation tone', dashed: true },
        ] },
        { label: 'timeout, "show me", or low confidence', steps: [
          { from: 'd', to: 'hook', t: 'no decision', dashed: true },
          { from: 'hook', to: 'cc', t: 'exit 0 → normal dialog', dashed: true },
        ] },
      ] },
    ],
    caption: 'Voice never grants persistent rules (no updatedPermissions). "deny" returns behavior: "deny" with message "Denied by voice".',
  });
}

const diagrams = {
  '01-system-context': systemContext(),
  '02-components': components(),
  '03-sequence-turn-end': turnEnd(),
  '04-sequence-voice-approval': voicePermission(),
};

for (const [name, svg] of Object.entries(diagrams)) {
  const svgPath = join(OUT, `${name}.svg`);
  writeFileSync(svgPath, svg);
  try {
    execFileSync('rsvg-convert', ['-z', '2', '-o', join(OUT, `${name}.png`), svgPath]);
  } catch {
    console.warn(`PNG skipped for ${name} (rsvg-convert not found)`);
  }
  console.log(`wrote ${name}`);
}
