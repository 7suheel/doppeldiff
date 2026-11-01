// src/core/runner/child.ts
import { pathToFileURL } from "node:url";
import vm from "node:vm";

// src/core/runner/encode.ts
var DEFAULT_LIMITS = { maxNodes: 2e4, maxDepth: 24 };
var toStringTag = (v) => Object.prototype.toString.call(v).slice(8, -1);
function ctorName(v) {
  const proto = Object.getPrototypeOf(v);
  if (proto === null) return "null-prototype";
  if (proto === Object.prototype) return null;
  const ctor = proto.constructor;
  if (typeof ctor === "function" && typeof ctor.name === "string" && ctor.name) {
    if (ctor.name === "Object" && Object.getPrototypeOf(proto) === null) return null;
    return ctor.name;
  }
  return "anonymous";
}
function encode(value, limits = DEFAULT_LIMITS) {
  let nodes = 0;
  const stack = [];
  const enc = (v, depth) => {
    if (++nodes > limits.maxNodes) return { t: "truncated", reason: "too many nodes" };
    switch (typeof v) {
      case "undefined":
        return { t: "undefined" };
      case "boolean":
        return { t: "boolean", v };
      case "number":
        return { t: "number", v };
      case "bigint":
        return { t: "bigint", v: v.toString() };
      case "string":
        return { t: "string", v };
      case "symbol":
        return { t: "symbol", d: v.description ?? "" };
      case "function":
        return { t: "function", name: v.name, length: v.length };
    }
    if (v === null) return { t: "null" };
    const obj = v;
    const cycleAt = stack.lastIndexOf(obj);
    if (cycleAt !== -1) return { t: "cycle", up: stack.length - cycleAt };
    if (depth > limits.maxDepth) return { t: "truncated", reason: "too deep" };
    stack.push(obj);
    try {
      return encObject(obj, depth);
    } finally {
      stack.pop();
    }
  };
  const readProp = (obj, key, depth) => {
    try {
      return enc(obj[key], depth + 1);
    } catch (e) {
      return { t: "truncated", reason: `getter threw: ${String(e?.message ?? e)}` };
    }
  };
  const encObject = (obj, depth) => {
    const tag = toStringTag(obj);
    if (Array.isArray(obj)) {
      const items = [];
      for (let i = 0; i < obj.length; i++) items.push(readProp(obj, String(i), depth));
      return { t: "array", items };
    }
    if (tag === "Date") return { t: "date", v: Date.prototype.getTime.call(obj) };
    if (tag === "RegExp") {
      const r = obj;
      return { t: "regexp", source: r.source, flags: r.flags };
    }
    if (tag === "Map") {
      const entries2 = [];
      for (const [k, val] of Map.prototype.entries.call(obj)) {
        entries2.push([enc(k, depth + 1), enc(val, depth + 1)]);
      }
      return { t: "map", entries: entries2 };
    }
    if (tag === "Set") {
      const items = [];
      for (const val of Set.prototype.values.call(obj)) items.push(enc(val, depth + 1));
      return { t: "set", items };
    }
    if (tag === "Promise") return { t: "promise" };
    if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
      const arr = obj;
      return {
        t: "typed",
        ctor: ctorName(obj) ?? tag,
        items: Array.from(arr, (x) => Number(x))
      };
    }
    if (obj instanceof Error || tag === "Error") {
      const e = obj;
      const props = [];
      for (const key of Object.keys(e)) {
        if (key === "stack" || key === "message") continue;
        props.push([key, readProp(e, key, depth)]);
      }
      let message;
      try {
        message = String(e.message);
      } catch {
        message = "<unreadable>";
      }
      return { t: "error", ctor: ctorName(e) ?? "Error", message, props };
    }
    const entries = [];
    for (const key of Object.keys(obj)) entries.push([key, readProp(obj, key, depth)]);
    return { t: "object", ctor: ctorName(obj), entries };
  };
  try {
    return enc(value, 0);
  } catch (e) {
    return { t: "truncated", reason: `encoding failed: ${String(e?.message ?? e)}` };
  }
}

// src/core/runner/determinism.ts
import { createRequire, syncBuiltinESMExports } from "node:module";
function sfc32(a, b, c, d) {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (a + b | 0) + d | 0;
    d = d + 1 | 0;
    a = b ^ b >>> 9;
    b = c + (c << 3) | 0;
    c = c << 21 | c >>> 11;
    c = c + t | 0;
    return (t >>> 0) / 4294967296;
  };
}
function installDeterminism(options) {
  const require2 = createRequire(import.meta.url);
  const RealDate = Date;
  const now = options.now;
  let rand = sfc32(options.seed, 2654435769, 608135816, 3084996962);
  function FakeDate(...args) {
    if (!new.target) return new RealDate(now).toString();
    if (args.length === 0) return new RealDate(now);
    return new RealDate(...args);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => now;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  Object.defineProperty(FakeDate, "name", { value: "Date" });
  globalThis.Date = FakeDate;
  Math.random = () => rand();
  const fillRandom = (view) => {
    if (view) {
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(rand() * 256);
    }
    return view;
  };
  const uuid = () => {
    const b = fillRandom(new Uint8Array(16));
    b[6] = b[6] & 15 | 64;
    b[8] = b[8] & 63 | 128;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  const nodeCrypto = require2("node:crypto");
  const webcrypto = globalThis.crypto;
  try {
    Object.defineProperty(webcrypto, "getRandomValues", {
      value: fillRandom,
      configurable: true,
      writable: true
    });
    Object.defineProperty(webcrypto, "randomUUID", { value: uuid, configurable: true, writable: true });
  } catch {
  }
  const set = (target, key, value) => {
    try {
      Object.defineProperty(target, key, { value, configurable: true, writable: true, enumerable: true });
    } catch {
    }
  };
  set(nodeCrypto, "randomUUID", uuid);
  set(nodeCrypto, "getRandomValues", fillRandom);
  set(nodeCrypto, "randomBytes", (size, cb) => {
    const buf = fillRandom(Buffer.alloc(size));
    if (cb) {
      queueMicrotask(() => cb(null, buf));
      return void 0;
    }
    return buf;
  });
  set(nodeCrypto, "randomInt", (min, max) => {
    const [lo, hi] = max === void 0 ? [0, min] : [min, max];
    return lo + Math.floor(rand() * (hi - lo));
  });
  syncBuiltinESMExports();
  return {
    reset() {
      rand = sfc32(options.seed, 2654435769, 608135816, 3084996962);
    }
  };
}

// src/core/runner/netguard.ts
import { createRequire as createRequire2, syncBuiltinESMExports as syncBuiltinESMExports2 } from "node:module";
function installNetGuard() {
  const require2 = createRequire2(import.meta.url);
  const deny = (what) => function denied() {
    const err = new Error(`doppeldiff: network access denied (${what})`);
    err.code = "ERR_ACCESS_DENIED";
    throw err;
  };
  const patch = (mod, keys, label) => {
    for (const k of keys) {
      if (typeof mod[k] === "function") {
        try {
          mod[k] = deny(`${label}.${k}`);
        } catch {
        }
      }
    }
  };
  const net = require2("node:net");
  patch(net, ["connect", "createConnection", "createServer"], "net");
  net.Socket.prototype.connect = deny("net.Socket.connect");
  patch(require2("node:tls"), ["connect", "createServer"], "tls");
  patch(require2("node:http"), ["request", "get", "createServer"], "http");
  patch(require2("node:https"), ["request", "get", "createServer"], "https");
  patch(require2("node:http2"), ["connect", "createServer"], "http2");
  patch(require2("node:dgram"), ["createSocket"], "dgram");
  const dnsKeys = [
    "lookup",
    "resolve",
    "resolve4",
    "resolve6",
    "resolveAny",
    "resolveMx",
    "resolveTxt",
    "reverse"
  ];
  const dns = require2("node:dns");
  patch(dns, dnsKeys, "dns");
  if (dns.promises) patch(dns.promises, dnsKeys, "dns.promises");
  const g = globalThis;
  for (const k of ["fetch", "WebSocket", "EventSource"]) {
    if (typeof g[k] === "function") g[k] = deny(k);
  }
  syncBuiltinESMExports2();
}

// src/core/runner/tags.ts
var FN_TAG = "__doppeldiff_fn__";
function isFnDescriptor(v) {
  return typeof v === "object" && v !== null && Object.prototype.hasOwnProperty.call(v, FN_TAG);
}

// src/core/runner/child.ts
var modules = /* @__PURE__ */ new Map();
var determinism;
var current;
var send = (msg) => process.send(msg);
process.on("uncaughtException", (err) => current?.fail(err));
process.on("unhandledRejection", (err) => current?.fail(err));
process.on("disconnect", () => process.exit(0));
function materialize(value, seen = /* @__PURE__ */ new Set()) {
  if (isFnDescriptor(value)) {
    const { returns, async } = value[FN_TAG];
    return async ? async function stub() {
      return structuredClone(returns);
    } : function stub() {
      return structuredClone(returns);
    };
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = materialize(value[i], seen);
  } else if (value instanceof Map) {
    for (const [k, v] of value) value.set(k, materialize(v, seen));
  } else if (Object.getPrototypeOf(value) === Object.prototype) {
    const rec = value;
    for (const k of Object.keys(rec)) rec[k] = materialize(rec[k], seen);
  }
  return value;
}
function resolveExport(mod, name) {
  if (name in mod) return mod[name];
  const def = mod.default;
  if (def && (typeof def === "object" || typeof def === "function") && name in def) return def[name];
  return void 0;
}
function isThenable(v) {
  return (typeof v === "object" || typeof v === "function") && v !== null && typeof v.then === "function";
}
var guardContext = vm.createContext({});
var guardScript = new vm.Script("__dd_fn(...__dd_args)");
async function callOnce(fn, input, timeoutMs, guard) {
  const args = materialize(structuredClone(input));
  determinism?.reset();
  let result;
  try {
    if (guard) {
      const ctx = guardContext;
      ctx.__dd_fn = fn;
      ctx.__dd_args = args;
      try {
        result = guardScript.runInContext(guardContext, { timeout: timeoutMs });
      } finally {
        ctx.__dd_fn = void 0;
        ctx.__dd_args = void 0;
      }
    } else {
      result = fn(...args);
    }
  } catch (error) {
    if (guard && error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      return { kind: "timeout", ms: timeoutMs };
    }
    return { kind: "throw", error: encode(error), async: false, args: args.map((a) => encode(a)) };
  }
  if (!isThenable(result)) {
    return { kind: "return", value: encode(result), async: false, args: args.map((a) => encode(a)) };
  }
  let timer;
  try {
    const settled = await new Promise((resolve) => {
      current = { fail: (error) => resolve({ ok: false, value: error }) };
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      Promise.resolve(result).then(
        (value) => resolve({ ok: true, value }),
        (error) => resolve({ ok: false, value: error })
      );
    });
    if (settled === "timeout") return { kind: "timeout", ms: timeoutMs };
    const encodedArgs = args.map((a) => encode(a));
    return settled.ok ? { kind: "return", value: encode(settled.value), async: true, args: encodedArgs } : { kind: "throw", error: encode(settled.value), async: true, args: encodedArgs };
  } finally {
    current = void 0;
    if (timer) clearTimeout(timer);
  }
}
async function run(msg) {
  const mod = modules.get(msg.moduleId);
  const fn = mod ? resolveExport(mod, msg.exportName) : void 0;
  for (let i = 0; i < msg.inputs.length; i++) {
    let outcome;
    if (typeof fn !== "function") {
      outcome = { kind: "crash", reason: `export \`${msg.exportName}\` is not a function` };
    } else {
      outcome = await callOnce(fn, msg.inputs[i], msg.timeoutMs, msg.guard);
    }
    send({ t: "result", reqId: msg.reqId, index: i, outcome });
  }
  send({ t: "done", reqId: msg.reqId });
}
var queue = Promise.resolve();
process.on("message", (raw) => {
  const msg = raw;
  queue = queue.then(async () => {
    switch (msg.t) {
      case "init": {
        if (msg.netGuard) installNetGuard();
        if (msg.freeze) determinism = installDeterminism({ now: msg.now, seed: msg.seed });
        if (!msg.showConsole) {
          const noop = () => {
          };
          for (const k of ["log", "info", "warn", "error", "debug", "trace", "dir", "table"]) {
            console[k] = noop;
          }
        }
        send({ t: "ready", node: process.version });
        break;
      }
      case "load": {
        try {
          const mod = await import(pathToFileURL(msg.path).href);
          modules.set(msg.moduleId, mod);
          const def = mod.default;
          const names = new Set(Object.keys(mod));
          if (def && typeof def === "object") for (const k of Object.keys(def)) names.add(k);
          send({ t: "loaded", moduleId: msg.moduleId, ok: true, exports: [...names] });
        } catch (e) {
          const err = e;
          send({
            t: "loaded",
            moduleId: msg.moduleId,
            ok: false,
            error: {
              name: err?.name ?? "Error",
              message: String(err?.message ?? e),
              ...err?.code ? { code: err.code } : {}
            },
            exports: []
          });
        }
        break;
      }
      case "run":
        await run(msg);
        break;
    }
  }).catch((e) => {
    process.stderr.write(`doppeldiff runner internal error: ${e?.stack ?? String(e)}
`);
    process.exit(70);
  });
});
//# sourceMappingURL=child.js.map
