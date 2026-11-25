// Paths shared by the shim and the daemon. Keep this file dependency-free: the shim imports it.
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Unix socket the daemon listens on (mode 0600). */
export function socketPath() {
  if (process.env.READBACK_SOCKET) return process.env.READBACK_SOCKET;
  const dir = process.env.XDG_RUNTIME_DIR || '/tmp';
  return join(dir, `readback-${process.getuid?.() ?? 0}.sock`);
}

/** Lock file that stops two daemons starting at once. */
export function lockPath() {
  return socketPath().replace(/\.sock$/, '') + '.lock';
}

/** Persistent per-user data: log, downloaded models. */
export function dataDir() {
  return process.env.READBACK_DATA_DIR
    || process.env.CLAUDE_PLUGIN_DATA
    || join(homedir(), '.local', 'share', 'readback');
}

/** User config file. */
export function userConfigPath() {
  return process.env.READBACK_CONFIG
    || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'readback', 'config.toml');
}
