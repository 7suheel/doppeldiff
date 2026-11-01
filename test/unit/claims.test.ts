import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { matchClaims } from '../../src/core/claims/match.js';
import {
  anthropicProvider,
  openaiProvider,
  selectProvider,
  type LlmProvider,
  type StructuredRequest,
} from '../../src/core/claims/providers.js';
import { conforms, conformsSignature, parseLiteral, suggestInputs } from '../../src/core/claims/suggest.js';
import { quotedValues, validateClaimResponse } from '../../src/core/claims/validate.js';
import type { Report } from '../../src/core/report/model.js';
import { SCHEMA_VERSION } from '../../src/core/report/model.js';
import type { SignatureSpec } from '../../src/core/types/spec.js';

function fakeProvider(
  responses: (string | ((req: StructuredRequest) => string))[],
): LlmProvider & { calls: StructuredRequest[] } {
  const calls: StructuredRequest[] = [];
  return {
    name: 'fake',
    model: 'fake-1',
    calls,
    async complete(req) {
      calls.push(req);
      const r = responses[Math.min(calls.length - 1, responses.length - 1)]!;
      return typeof r === 'function' ? r(req) : r;
    },
  };
}

function sampleReport(claim: string | null = 'Fix discount rounding for prices over $1000'): Report {
  const view = (display: string) => ({ kind: 'return' as const, async: false, display, code: display });
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'doppeldiff', version: '0.0.0' },
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: { ref: 'pr', sha: 'b'.repeat(40) },
    claim: { source: 'flag', text: claim, refactor: false, llm: null },
    settings: { seed: 1, runs: 1000, timeoutMs: 250, timeBudgetMs: null, freeze: true },
    summary: {
      verdict: 'changes',
      functions: 2,
      changed: 2,
      unchanged: 0,
      skipped: 0,
      nondeterministic: 0,
      behaviors: 2,
      edgeCaseBehaviors: 0,
      unclaimed: 0,
      unclaimedRealistic: 0,
      inputsRun: 2000,
      durationMs: 1,
    },
    functions: [
      {
        id: 'src/pricing.ts#applyDiscount',
        file: 'src/pricing.ts',
        exportName: 'applyDiscount',
        status: 'changed',
        inputsRun: 1000,
        failures: 0,
        durationMs: 1,
        seed: 1,
        behaviors: [
          {
            id: 'src/pricing.ts#applyDiscount/1',
            key: 'k',
            title: 'return value changed',
            label: 'behavior-change',
            labelSource: 'none',
            realism: 'ordinary',
            count: 3,
            variants: [],
            examples: [
              {
                call: 'applyDiscount(2000, 0.07)',
                argsCode: '2000, 0.07',
                old: view('1859.99'),
                new: view('1860'),
                minimal: true,
              },
            ],
          },
        ],
      },
      {
        id: 'src/cart.ts#cartTotal',
        file: 'src/cart.ts',
        exportName: 'cartTotal',
        status: 'changed',
        inputsRun: 1000,
        failures: 0,
        durationMs: 1,
        seed: 1,
        behaviors: [
          {
            id: 'src/cart.ts#cartTotal/1',
            key: 'k2',
            title: 'now returns NaN (previously a number)',
            label: 'behavior-change',
            labelSource: 'none',
            realism: 'ordinary',
            count: 40,
            variants: [],
            examples: [
              {
                call: 'cartTotal([{ sku: "", unitPrice: NaN, quantity: 0 }])',
                old: view('0'),
                new: view('NaN'),
                minimal: true,
              },
            ],
          },
        ],
      },
    ],
    skipped: [],
    added: [],
    removed: [],
    identical: [],
    errors: [],
    regressionTests: null,
    timing: { totalMs: 1, materializeMs: 0, dependenciesMs: 0, detectMs: 0, verifyMs: 0 },
  };
}

const good = JSON.stringify({
  behaviors: [
    {
      id: 'src/pricing.ts#applyDiscount/1',
      label: 'claimed',
      explanation: 'Prices over $1000 are now rounded to the nearest cent (1859.99 becomes 1860).',
    },
    {
      id: 'src/cart.ts#cartTotal/1',
      label: 'suspicious',
      explanation:
        'cartTotal now returns NaN for zero-quantity items with a NaN price; the PR only mentions discounts.',
    },
  ],
});

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const freshCache = () => {
  const d = mkdtempSync(join(tmpdir(), 'dd-llm-cache-'));
  dirs.push(d);
  return d;
};

describe('claim validation', () => {
  it('extracts quoted values and numbers', () => {
    expect(quotedValues('was "e", now `""` and 1,104.99 vs 1105 or -0.5')).toEqual([
      'e',
      '""',
      '1,104.99',
      '1105',
      '-0.5',
    ]);
  });

  it('accepts evidence-backed labels and rejects invented ids, duplicates and invented values', () => {
    const r = sampleReport();
    const ok = validateClaimResponse(JSON.parse(good), r, '');
    expect(ok.problems).toEqual([]);
    expect(ok.labels.size).toBe(2);

    const bad = validateClaimResponse(
      {
        behaviors: [
          {
            id: 'src/pricing.ts#applyDiscount/1',
            label: 'claimed',
            explanation: 'Now returns 1105 for 1299.99.',
          },
          { id: 'made-up', label: 'unclaimed', explanation: 'x' },
          { id: 'src/cart.ts#cartTotal/1', label: 'unclaimed', explanation: 'NaN appears.' },
          { id: 'src/cart.ts#cartTotal/1', label: 'claimed', explanation: 'dup' },
        ],
      },
      r,
      '',
    );
    expect(bad.labels.size).toBe(0);
    expect(bad.problems.join('\n')).toMatch(/not in the evidence \(1105, 1299.99\)/);
    expect(bad.problems.join('\n')).toMatch(/unknown behavior id/);
    expect(bad.problems.join('\n')).toMatch(/more than once/);
  });

  it('rejects responses that do not match the schema', () => {
    expect(validateClaimResponse({ nope: 1 }, sampleReport(), '').problems[0]).toMatch(/schema/);
  });
});

describe('matchClaims', () => {
  it('applies validated labels, recomputes the summary and records the model', async () => {
    const p = fakeProvider([good]);
    const m = await matchClaims(sampleReport(), { provider: p, diff: 'diff --git', cacheDir: null });
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.user).toContain('<pr_description>');
    expect(m.labeled).toBe(2);
    const labels = m.report.functions.map((f) => f.behaviors[0]!.label);
    expect(labels).toEqual(['claimed', 'suspicious']);
    expect(m.report.summary).toMatchObject({ verdict: 'unclaimed', unclaimed: 1 });
    expect(m.report.claim.llm).toEqual({ provider: 'fake', model: 'fake-1' });
  });

  it('retries once with feedback and keeps rejected behaviors neutral', async () => {
    const halluc = JSON.stringify({
      behaviors: [{ id: 'src/pricing.ts#applyDiscount/1', label: 'claimed', explanation: 'Returns 42 now.' }],
    });
    const p = fakeProvider([halluc, halluc]);
    const warnings: string[] = [];
    const m = await matchClaims(sampleReport(), {
      provider: p,
      diff: '',
      cacheDir: null,
      onWarning: (w) => warnings.push(w),
    });
    expect(p.calls).toHaveLength(2);
    expect(p.calls[1]!.user).toMatch(/previous answer had these problems/);
    expect(m.labeled).toBe(0);
    expect(m.report.functions.every((f) => f.behaviors[0]!.label === 'behavior-change')).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('caches validated responses', async () => {
    const cacheDir = freshCache();
    const p1 = fakeProvider([good]);
    await matchClaims(sampleReport(), { provider: p1, diff: 'd', cacheDir });
    const p2 = fakeProvider(['should not be called']);
    const m = await matchClaims(sampleReport(), { provider: p2, diff: 'd', cacheDir });
    expect(p2.calls).toHaveLength(0);
    expect(m.cached).toBe(true);
    expect(m.labeled).toBe(2);
  });

  it('does not call the LLM without a claim or in refactor mode', async () => {
    const p = fakeProvider([good]);
    await matchClaims(sampleReport(null), { provider: p, diff: '', cacheDir: null });
    const refactor = sampleReport('Pure refactor');
    refactor.claim.refactor = true;
    await matchClaims(refactor, { provider: p, diff: '', cacheDir: null });
    expect(p.calls).toHaveLength(0);
  });
});

describe('input suggestions', () => {
  it('parses literals safely', () => {
    expect(parseLiteral('[1000.01, -0, NaN, "a\\"b", undefined, null, {a: [1], "b-c": true}]')).toEqual([
      1000.01,
      -0,
      NaN,
      'a"b',
      undefined,
      null,
      { a: [1], 'b-c': true },
    ]);
    expect(Object.is((parseLiteral('[-0]') as number[])[0], -0)).toBe(true);
    for (const bad of ['[process.exit(1)]', '[1 + 1]', '{__proto__: {}}', '[new Date()]', '[1] ; x']) {
      expect(() => parseLiteral(bad), bad).toThrow();
    }
  });

  it('validates suggestions against parameter types', () => {
    const sig: SignatureSpec = {
      params: [
        {
          name: 'items',
          spec: {
            kind: 'array',
            items: { kind: 'object', props: [{ name: 'q', spec: { kind: 'number' }, optional: false }] },
          },
          optional: false,
          rest: false,
        },
        {
          name: 'mode',
          spec: { kind: 'union', options: [{ kind: 'literal', value: 'a' }, { kind: 'undefined' }] },
          optional: true,
          rest: false,
        },
      ],
      async: false,
    };
    expect(conformsSignature(sig, [[{ q: 1 }], 'a'])).toBe(true);
    expect(conformsSignature(sig, [[{ q: 1 }]])).toBe(true);
    expect(conformsSignature(sig, [[{ q: '1' }]])).toBe(false);
    expect(conformsSignature(sig, [[], 'b'])).toBe(false);
    expect(conformsSignature(sig, [[], 'a', 3])).toBe(false);
    expect(conforms({ kind: 'date' }, '2020-01-01')).toBe(false);
  });

  it('keeps only valid suggestions', async () => {
    const p = fakeProvider([
      JSON.stringify({
        inputs: [{ args: '[123457]' }, { args: '["x"]' }, { args: '[eval("1")]' }, { args: '[1, 2]' }],
      }),
    ]);
    const sig: SignatureSpec = {
      params: [{ name: 'x', spec: { kind: 'number' }, optional: false, rest: false }],
      async: false,
    };
    const r = await suggestInputs(p, {
      name: 'f',
      signature: 'f(x: number)',
      spec: sig,
      baseSource: 'a',
      headSource: 'b',
    });
    expect(r.accepted).toEqual([[123457]]);
    expect(r.rejected).toBe(3);
  });
});

describe('provider selection', () => {
  it('is off by default, even when API keys are present', () => {
    expect(selectProvider({ env: {} })).toBeNull();
    expect(selectProvider({ env: { ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y' } })).toBeNull();
  });
  it('uses exactly what is chosen', () => {
    expect(selectProvider({ env: { ANTHROPIC_API_KEY: 'x', DOPPELDIFF_LLM: 'auto' } })?.name).toBe(
      'anthropic',
    );
    expect(selectProvider({ env: { OPENAI_API_KEY: 'y' }, provider: 'auto' })?.name).toBe('openai');
    expect(selectProvider({ env: {}, provider: 'anthropic', model: 'claude-sonnet-5-5' })?.model).toBe(
      'claude-sonnet-5-5',
    );
    const ollama = selectProvider({ env: {}, provider: 'ollama', model: 'qwen2.5:7b' });
    expect(ollama).toMatchObject({ name: 'openai-compatible', model: 'qwen2.5:7b' });
    expect(() => selectProvider({ env: {}, provider: 'ollama' })).toThrow(/--llm-model/);
    expect(() => selectProvider({ env: {}, provider: 'openai-compatible', model: 'm' })).toThrow(
      /--llm-base-url/,
    );
  });
});

describe('real SDK request shapes (local mock server, no network)', () => {
  async function withServer(
    respond: (path: string, body: Record<string, unknown>) => unknown,
    fn: (
      url: string,
      seen: { path: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }[],
    ) => Promise<void>,
  ) {
    const seen: { path: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }[] = [];
    const server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const body = JSON.parse(data || '{}') as Record<string, unknown>;
        seen.push({ path: req.url ?? '', headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(respond(req.url ?? '', body)));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      await fn(`http://127.0.0.1:${port}`, seen);
    } finally {
      server.close();
    }
  }

  it('Anthropic: structured output, low effort, default fallbacks, no sampling params', async () => {
    await withServer(
      () => ({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: '{"behaviors":[]}' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      async (url, seen) => {
        const prev = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL };
        process.env.ANTHROPIC_API_KEY = 'test-key';
        process.env.ANTHROPIC_BASE_URL = url;
        try {
          const text = await anthropicProvider().complete({
            system: 's',
            user: 'u',
            schema: { type: 'object' },
            schemaName: 'n',
          });
          expect(text).toBe('{"behaviors":[]}');
        } finally {
          process.env.ANTHROPIC_API_KEY = prev.key;
          if (prev.base === undefined) delete process.env.ANTHROPIC_BASE_URL;
          else process.env.ANTHROPIC_BASE_URL = prev.base;
          if (prev.key === undefined) delete process.env.ANTHROPIC_API_KEY;
        }
        const req = seen[0]!;
        expect(req.path).toMatch(/^\/v1\/messages/);
        expect(String(req.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
        expect(req.body).toMatchObject({
          model: 'claude-opus-5-5',
          fallbacks: 'default',
          output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } },
        });
        expect(req.body).not.toHaveProperty('temperature');
        expect(req.body).not.toHaveProperty('thinking');
      },
    );
  });

  it('OpenAI: Responses API with strict JSON schema', async () => {
    await withServer(
      () => ({
        id: 'resp_1',
        object: 'response',
        created_at: 0,
        status: 'completed',
        model: 'gpt-5.5',
        output: [
          {
            type: 'message',
            id: 'm1',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: '{"inputs":[]}', annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
      async (url, seen) => {
        const prev = { key: process.env.OPENAI_API_KEY, base: process.env.OPENAI_BASE_URL };
        process.env.OPENAI_API_KEY = 'test-key';
        process.env.OPENAI_BASE_URL = `${url}/v1`;
        try {
          const text = await openaiProvider().complete({
            system: 's',
            user: 'u',
            schema: { type: 'object' },
            schemaName: 'n',
          });
          expect(text).toBe('{"inputs":[]}');
        } finally {
          if (prev.key === undefined) delete process.env.OPENAI_API_KEY;
          else process.env.OPENAI_API_KEY = prev.key;
          if (prev.base === undefined) delete process.env.OPENAI_BASE_URL;
          else process.env.OPENAI_BASE_URL = prev.base;
        }
        expect(seen[0]!.path).toBe('/v1/responses');
        expect(seen[0]!.body).toMatchObject({
          model: 'gpt-5.5',
          instructions: 's',
          input: 'u',
          text: { format: { type: 'json_schema', name: 'n', strict: true } },
        });
      },
    );
  });
});

describe('OpenAI-compatible endpoint (Ollama etc.)', () => {
  it('sends a JSON-schema chat completion and falls back to JSON mode', async () => {
    const { openaiCompatibleProvider } = await import('../../src/core/claims/providers.js');
    const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
    let rejectSchema = false;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, body, auth: new Headers(init.headers).get('authorization') });
      const rf = body.response_format as { type: string };
      if (rejectSchema && rf.type === 'json_schema') {
        return new Response(JSON.stringify({ error: { message: 'unsupported' } }), { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const req = { system: 's', user: 'u', schema: { type: 'object' }, schemaName: 'n' };
    const p = openaiCompatibleProvider({
      baseUrl: 'http://localhost:11434/v1/',
      model: 'qwen2.5:7b',
      fetchImpl: fakeFetch,
    });
    expect(await p.complete(req)).toBe('{"ok":true}');
    expect(calls[0]).toMatchObject({ url: 'http://localhost:11434/v1/chat/completions', auth: null });
    expect(calls[0]!.body).toMatchObject({
      model: 'qwen2.5:7b',
      temperature: 0,
      response_format: { type: 'json_schema', json_schema: { name: 'n', strict: true } },
    });
    rejectSchema = true;
    const keyed = openaiCompatibleProvider({
      baseUrl: 'http://x/v1',
      model: 'm',
      apiKey: 'k',
      fetchImpl: fakeFetch,
    });
    expect(await keyed.complete(req)).toBe('{"ok":true}');
    expect(calls.at(-1)).toMatchObject({
      auth: 'Bearer k',
      body: { response_format: { type: 'json_object' } },
    });
  });
});
