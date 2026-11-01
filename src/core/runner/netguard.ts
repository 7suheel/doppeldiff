import { createRequire, syncBuiltinESMExports } from 'node:module';

/**
 * Network guard for Node versions whose permission model does not restrict network access.
 * This is a guardrail against accidental network use by code under test, NOT a security boundary.
 */
export function installNetGuard(): void {
  const require = createRequire(import.meta.url);
  const deny = (what: string) =>
    function denied(): never {
      const err = new Error(`doppeldiff: network access denied (${what})`) as Error & { code: string };
      err.code = 'ERR_ACCESS_DENIED';
      throw err;
    };
  const patch = (mod: Record<string, unknown>, keys: string[], label: string) => {
    for (const k of keys) {
      if (typeof mod[k] === 'function') {
        try {
          mod[k] = deny(`${label}.${k}`);
        } catch {
          /* ignore */
        }
      }
    }
  };
  const net = require('node:net') as Record<string, unknown> & {
    Socket: { prototype: Record<string, unknown> };
  };
  patch(net, ['connect', 'createConnection', 'createServer'], 'net');
  net.Socket.prototype.connect = deny('net.Socket.connect');
  patch(require('node:tls') as Record<string, unknown>, ['connect', 'createServer'], 'tls');
  patch(require('node:http') as Record<string, unknown>, ['request', 'get', 'createServer'], 'http');
  patch(require('node:https') as Record<string, unknown>, ['request', 'get', 'createServer'], 'https');
  patch(require('node:http2') as Record<string, unknown>, ['connect', 'createServer'], 'http2');
  patch(require('node:dgram') as Record<string, unknown>, ['createSocket'], 'dgram');
  const dnsKeys = [
    'lookup',
    'resolve',
    'resolve4',
    'resolve6',
    'resolveAny',
    'resolveMx',
    'resolveTxt',
    'reverse',
  ];
  const dns = require('node:dns') as Record<string, unknown>;
  patch(dns, dnsKeys, 'dns');
  if (dns.promises) patch(dns.promises as Record<string, unknown>, dnsKeys, 'dns.promises');
  const g = globalThis as Record<string, unknown>;
  for (const k of ['fetch', 'WebSocket', 'EventSource']) {
    if (typeof g[k] === 'function') g[k] = deny(k);
  }
  syncBuiltinESMExports();
}

/** True if this Node's permission model restricts network access natively (`--allow-net` exists). */
export function nativeNetPermission(): boolean {
  return process.allowedNodeEnvironmentFlags.has('--allow-net');
}
