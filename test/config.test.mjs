import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseToml, loadConfig, inQuietHours, saveUserSetting } from '../src/daemon/config.mjs';

test('parseToml reads the schema subset', () => {
  const t = parseToml('mode = "chatty" # comment\nrate=210\nvoice_approval = false\nnever_by_voice = ["npm publish", \'x#y\']\n[table]\nbad line');
  assert.deepEqual(t, { mode: 'chatty', rate: 210, voice_approval: false, never_by_voice: ['npm publish', 'x#y'] });
});

test('project file cannot loosen safety or change engines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rbcfg-'));
  const user = join(dir, 'user.toml');
  writeFileSync(user, 'voice_approval = false\nnever_by_voice = ["a"]\n');
  mkdirSync(join(dir, 'repo', '.claude'), { recursive: true });
  writeFileSync(join(dir, 'repo', '.claude', 'readback.toml'),
    'voice_approval = true\nengine = "openai"\nanswer_timeout = 25\nnever_by_voice = ["b"]\nmode = "chatty"\n');
  process.env.READBACK_CONFIG = user;
  try {
    const c = loadConfig({ cwd: join(dir, 'repo') });
    assert.equal(c.voice_approval, false);
    assert.equal(c.engine, 'auto');
    assert.equal(c.answer_timeout, 20);
    assert.equal(c.mode, 'chatty');
    assert.deepEqual(c.never_by_voice, ['a', 'b']);
  } finally { delete process.env.READBACK_CONFIG; }
});

test('invalid values fall back to defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rbcfg-'));
  process.env.READBACK_CONFIG = join(dir, 'c.toml');
  writeFileSync(process.env.READBACK_CONFIG, 'mode = "loud"\nrate = 5\nlistener_confidence = 0.1\nanswer_timeout = "x"\n');
  try {
    const c = loadConfig();
    assert.equal(c.mode, 'brief'); assert.equal(c.rate, 190);
    assert.equal(c.listener_confidence, 0); assert.equal(c.answer_timeout, 20);
  } finally { delete process.env.READBACK_CONFIG; }
});

test('saveUserSetting rewrites or appends one key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rbcfg-'));
  process.env.READBACK_CONFIG = join(dir, 'c.toml');
  try {
    saveUserSetting('mode', 'chatty');
    saveUserSetting('rate', 220);
    saveUserSetting('mode', 'alerts');
    assert.equal(readFileSync(process.env.READBACK_CONFIG, 'utf8'), 'mode = "alerts"\nrate = 220\n');
    assert.throws(() => saveUserSetting('voice_approval', true));
  } finally { delete process.env.READBACK_CONFIG; }
});

test('quiet hours wrap midnight', () => {
  const at = (h, m = 0) => new Date(2026, 0, 1, h, m);
  assert.ok(inQuietHours('22:00-07:00', at(23)));
  assert.ok(inQuietHours('22:00-07:00', at(6, 59)));
  assert.ok(!inQuietHours('22:00-07:00', at(7)));
  assert.ok(inQuietHours('12:00-13:00', at(12, 30)));
  assert.ok(!inQuietHours('', at(12)));
});

test('unknown engine and summarizer values are ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rb-cfg-eng-'));
  const file = join(dir, 'config.toml');
  writeFileSync(file, 'engine = "openai"\nsummarizer = "gpt"\n');
  process.env.READBACK_CONFIG = file;
  const cfg = loadConfig();
  assert.equal(cfg.engine, 'auto');
  assert.equal(cfg.summarizer, 'rules');
  writeFileSync(file, 'engine = "piper"\nsummarizer = "claude-haiku"\n');
  assert.equal(loadConfig().engine, 'piper');
  assert.equal(loadConfig().summarizer, 'claude-haiku');
});
