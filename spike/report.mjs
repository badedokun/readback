#!/usr/bin/env node
// Summarise M0 spike captures: node spike/report.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = process.env.READBACK_SPIKE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'raw');
const rows = (f) => existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const stop = rows('Stop.compare.jsonl');
const perm = rows('PermissionRequest.decisions.jsonl');
const intercepts = rows('prompt.intercepts.jsonl').filter((r) => r.hit);
const notif = rows('Notification.jsonl').map((r) => r.input.notification_type ?? r.input.type ?? '?');
console.log(`Stop turns: ${stop.length}  with last_assistant_message: ${stop.filter((r) => r.has_lam).length}`);
console.log(`  transcript matched at Stop: ${stop.filter((r) => r.transcript_at_stop_matches).length}   after 2s: ${stop.filter((r) => r.transcript_after_2s_matches).length}`);
console.log(`PermissionRequest decisions: ${perm.map((r) => `${r.mode}(${r.tool}, ${r.waited_ms}ms)`).join(', ') || 'none'}`);
console.log(`/readback:stop intercepts: ${intercepts.map((r) => r.event).join(', ') || 'none'}`);
console.log(`Notification types: ${[...new Set(notif)].join(', ') || 'none'}`);
