// Preloaded with NODE_OPTIONS=--import into the shim and the daemon for TC-50 / NFR-06.
// Unix-socket IPC is allowed; any TCP/TLS connection, DNS lookup or fetch is refused and
// appended to $READBACK_NETLOG.
import net from 'node:net';
import dns from 'node:dns';
import { appendFileSync } from 'node:fs';

const log = (what) => { try { appendFileSync(process.env.READBACK_NETLOG ?? '/dev/null', `${process.pid} ${what}\n`); } catch { /* ignore */ } };

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect() hands Socket#connect an internal [options, callback] array.
  const o = Array.isArray(args[0]) ? args[0][0] : args[0];
  const unix = typeof o === 'string' || (o && typeof o === 'object' && typeof o.path === 'string');
  if (!unix) {
    log(`connect ${JSON.stringify(typeof o === 'object' ? { host: o.host, port: o.port } : args.slice(0, 2))}`);
    process.nextTick(() => this.destroy(new Error('network disabled by test')));
    return this;
  }
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (host, ...rest) { log(`dns ${host}`); return lookup.call(this, 'invalid.invalid', ...rest); };
globalThis.fetch = async (url) => { log(`fetch ${String(url)}`); throw new Error('network disabled by test'); };
