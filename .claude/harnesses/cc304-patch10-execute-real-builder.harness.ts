// REVIEW HARNESS (not for merge) — Claude Code 2.1.304 PATCH 10 anchor repair.
//
// 2.1.304 gave the child-env builder an optional parameter, a base env the
// parent's `process.env` is spread over (`function is(e){…i={...e,...process.env}…`),
// and made the passthrough early-out require it to be absent (`if(e===void 0&&…)`).
// The anchor's head admitted only a zero-arg `function X(){`, and the body check
// required a literal `{...process.env`, so `clodex patch` refused the release.
//
// This drives the REAL applyClodexPatches over EVERY REAL 2.1.304 bundle, then
// EXTRACTS the patched builder and EXECUTES it — without the parameter, with it,
// and on the settings-env branch.
//
// Unlike cc290, the stub table is keyed by the darwin-arm64 build's own SPELLING
// and converted to first-appearance indices from that build; every other build
// must have the same token skeleton for those indices to mean the same thing,
// which is asserted. A binding is only proven present and correctly mapped when a
// scenario below REACHES it.
//
//   cat > /tmp/h304.config.ts <<'EOF'
//   import { defineConfig } from 'vitest/config';
//   export default defineConfig({ test: { include: ['.claude/harnesses/cc304-*.harness.ts'] } });
//   EOF
//   REVIEW_BUNDLE_DIR=~/.cache/clodex-review-bundles/2.1.304 pnpm vitest run --config /tmp/h304.config.ts
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { applyClodexPatches } from '../../src/patch-transforms.js';
import { NETWORK_ENV_CONTRACT_VAR } from '../../src/network-env.js';

const BUNDLE_DIR = process.env['REVIEW_BUNDLE_DIR'] ?? '';
const MARKER = '/*ccpatch:child-network-env*/';
const CONFIG = { 'clodex:openai:gpt-5.6-sol': { alias: 'sol', display: 'GPT-5.6 Sol' } };
const REFERENCE = 'darwin-arm64.js';

const PLATFORMS = [
  'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-arm64-musl',
  'linux-x64', 'linux-x64-musl', 'win32-arm64', 'win32-x64',
];

function bundles(): string[] {
  if (!BUNDLE_DIR || !existsSync(BUNDLE_DIR)) return [];
  return readdirSync(BUNDLE_DIR).filter(f => f.endsWith('.js')).sort();
}
const FILES = bundles();

function patchedBuilderSource(patched: string): string {
  const at = patched.indexOf(MARKER);
  expect(at, 'patch marker present').toBeGreaterThan(-1);
  const declStart = patched.slice(0, at).lastIndexOf('function ');
  let depth = 0;
  const open = patched.indexOf('{', declStart);
  for (let i = open; i < patched.length; i++) {
    if (patched[i] === '{') depth++;
    else if (patched[i] === '}') {
      depth--;
      if (depth === 0) return patched.slice(declStart, i + 1);
    }
  }
  throw new Error('unbalanced');
}

const TOKEN = /[A-Za-z_$][\w$]*/g;

function distinctTokens(src: string): string[] {
  const seen: string[] = [];
  for (const m of src.matchAll(TOKEN)) if (!seen.includes(m[0])) seen.push(m[0]);
  return seen;
}

function canonical(src: string): string {
  const seen = new Map<string, number>();
  return src.replace(TOKEN, t => {
    if (!seen.has(t)) seen.set(t, seen.size);
    return `#${seen.get(t)}`;
  });
}

const SENTINEL_PROXY_VALUE = '\u0000clodex-harness-proxy-sentinel';
const SENTINEL_SOCKET_VALUE = '\u0000clodex-harness-socket-sentinel';

/**
 * What the darwin-arm64 2.1.304 builder reads from the rest of the bundle, by its
 * own spelling, recovered by reading that builder in full. Every CONFIGURABLE stub
 * answers "no", as in cc290. `scrub` flips the flag that gates the credential tail;
 * `denyKey` makes the tail's deny predicate answer yes for exactly that name.
 */
function referenceBindings(
  scrub: boolean,
  denyKey: string | undefined,
  settingsEnv: Record<string, string>,
): Record<string, unknown> {
  return {
    O: { of: () => ({ getAgentProxyEnv: () => ({}), settingsEnvForChildren: settingsEnv }) }, // host registry
    j: () => ({ host: 'default' }),           // host resolver
    a: {},                                    // typed env accessor (every flag unset)
    PBr: (x: unknown) => x,                   // remote-mode proxy env builder
    IBr: () => scrub,                         // credential-scrub flag
    xe: new Set<string>(),                    // static uppercase deny set
    LGe: () => false,                         // uppercase-name deny predicate
    vZe: () => [],                            // dynamic deny list
    vjo: () => [],                            // second dynamic deny list
    gjt: () => false,                         // conditional dash-name gate
    B: new Set<string>(),                     // dash-name deny set
    Mde: (k: string) => k,                    // name normaliser
    zQe: [],                                  // static deny list (iterated twice)
    cP: () => false,                          // extra early-out predicate
    kE: {},                                   // second typed accessor
    G: () => false,                           // sandbox-mode predicate
    w: () => false,                           // BUN_JSC_ predicate
    Che: (_o: object, k: string) => k,        // case-insensitive key resolver (non-Windows: identity)
    FBr: () => [],                            // scrubbed-name list
    HBr: () => false,                         // FORCE_COLOR gate
    Ge: () => new Set<string>(),              // post-scrub deny set
    QSt: () => [],                            // sandbox-mode list
    dB: SENTINEL_PROXY_VALUE,                 // agent-proxy sentinel value
    GQe: SENTINEL_SOCKET_VALUE,               // unix-socket credential sentinel
    Fmn: /(?!)/,                              // deny pattern that never matches
    $mn: (k: string) => denyKey !== undefined && k === denyKey, // deny predicate
    LBr: () => false,                         // sandbox deny predicate
    Ijt: () => false,                         // skip predicate
    JSt: () => false,                         // "needs truncation" predicate
    Lmn: (_k: string, v: string) => ({ value: v, cut: false }),
    mWo: () => undefined,                     // spill-over name builder
    fWo: () => false,                         // spill-over collision check
    Nmn: (_k: string, v: string) => v,        // value sanitiser: identity
    uP: () => false,                          // "looks secret" predicate
  };
}

// Patched once: every other build is compared against it and mapped through its names.
const REFERENCE_BUILDER = FILES.includes(REFERENCE)
  ? patchedBuilderSource(
    applyClodexPatches(readFileSync(join(BUNDLE_DIR, REFERENCE), 'utf8'), CONFIG).content,
  )
  : '';
const REFERENCE_NAMES = distinctTokens(REFERENCE_BUILDER);

interface Scenario { scrub?: boolean; denyKey?: string; settingsEnv?: Record<string, string>; base?: Record<string, string> }

/** Execute the patched builder with `process.env` bound to `env`. */
function runBuilder(
  builder: string,
  env: Record<string, string>,
  opts: Scenario = {},
): Record<string, string> {
  const names = distinctTokens(builder);
  const bindings: Record<string, unknown> = { process: { env } };
  const byName = referenceBindings(opts.scrub ?? false, opts.denyKey, opts.settingsEnv ?? {});
  for (const [refName, value] of Object.entries(byName)) {
    const index = REFERENCE_NAMES.indexOf(refName);
    expect(index, `reference build has no token ${refName}`).toBeGreaterThan(-1);
    const name = names[index];
    expect(name, `no token at canonical index ${index}`).toBeDefined();
    bindings[name!] = value;
  }
  const params = Object.keys(bindings);
  const fn = new Function(...params, `return (${builder})`)(
    ...params.map(p => bindings[p]),
  ) as (base?: Record<string, string>) => Record<string, string>;
  return fn(opts.base);
}

const CONTRACT = JSON.stringify({
  version: 1,
  original: { HTTPS_PROXY: 'http://corp-proxy:3128', NODE_EXTRA_CA_CERTS: null },
  injected: { HTTPS_PROXY: 'http://127.0.0.1:49653', NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem' },
});

const injected = (): Record<string, string> => ({
  PATH: '/usr/bin',
  HTTPS_PROXY: 'http://127.0.0.1:49653',
  NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem',
  [NETWORK_ENV_CONTRACT_VAR]: CONTRACT,
});

describe.runIf(BUNDLE_DIR)('bundle availability', () => {
  it('finds one 2.1.304 bundle per published platform', () => {
    expect(
      PLATFORMS.filter(p => !FILES.includes(`${p}.js`)),
      `missing platform bundles in ${BUNDLE_DIR}`,
    ).toEqual([]);
  });

  it('holds eight distinct bundles, not one bundle copied eight times', () => {
    const digests = new Set(
      FILES.map(f => createHash('sha256').update(readFileSync(join(BUNDLE_DIR, f))).digest('hex')),
    );
    expect(digests.size, 'distinct bundle contents').toBe(FILES.length);
  });
});

describe.skipIf(FILES.length === 0)('Claude Code 2.1.304 — the patched builder, executed', () => {
  for (const file of FILES) {
    describe(file, () => {
      // Only what the tests read is kept, so the 47 MB patched bundle is not held alive
      // by every describe's closures at once.
      const { results, markers, bundleRefs, builder } = (() => {
        const outcome = applyClodexPatches(readFileSync(join(BUNDLE_DIR, file), 'utf8'), CONFIG);
        const patched = outcome.content;
        return {
          results: outcome.results,
          markers: patched.match(/\/\*ccpatch:child-network-env\*\//g)?.length ?? 0,
          bundleRefs: patched.split('_clodexChildEnv').length - 1,
          builder: patchedBuilderSource(patched),
        };
      })();

      it('applies every patch site, PATCH 10 included', () => {
        expect(results.filter(r => r.status !== 'OK')).toEqual([]);
        expect(markers).toBe(1);
      });

      it('produces a builder that still compiles', () => {
        expect(() => new Function(`return (${builder})`)).not.toThrow();
      });

      it('binds the one-parameter builder that folds in the agent-proxy env, and nothing escapes it', () => {
        expect(builder).toMatch(/^function [\w$]+\(([\w$]+)\)\{\/\*ccpatch:child-network-env\*\//);
        const param = builder.match(/^function [\w$]+\(([\w$]+)\)/)![1]!;
        expect(builder, 'the base copy spreads the parameter, then the restored env')
          .toContain(`={...${param},..._clodexChildEnv}`);
        expect(builder, 'the passthrough still requires the parameter to be absent')
          .toContain(`if(${param}===void 0&&`);
        expect(builder).toContain('getAgentProxyEnv');
        expect(builder).toContain('settingsEnvForChildren');
        expect(bundleRefs).toBe(builder.split('_clodexChildEnv').length - 1);
        expect(builder.match(/process\.env/g)).toHaveLength(1);
        expect(builder).toContain('let _clodexChildEnv=process.env,');
      });

      it('has the same identifier-token skeleton as the reference build', () => {
        const mine = canonical(builder);
        const theirs = canonical(REFERENCE_BUILDER);
        expect(mine, `${file} and ${REFERENCE} have different token skeletons`).toBe(theirs);
      });

      it('early-return branch: reverts to the external proxy and drops the CA + contract', () => {
        const out = runBuilder(builder, injected());
        expect(out['HTTPS_PROXY']).toBe('http://corp-proxy:3128');
        expect(out['NODE_EXTRA_CA_CERTS']).toBeUndefined();
        expect(out[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
        expect(out['PATH']).toBe('/usr/bin');
      });

      it('full-copy branch (credential scrub) also reverts and still scrubs secrets', () => {
        const env = { ...injected(), SCRUBBED: 'secret', CLAUDE_CODE_SUBSCRIPTION_TYPE: 'max' };
        const out = runBuilder(builder, env, { scrub: true, denyKey: 'SCRUBBED' });
        expect(out['HTTPS_PROXY']).toBe('http://corp-proxy:3128');
        expect(out['NODE_EXTRA_CA_CERTS']).toBeUndefined();
        expect(out[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
        expect(out['CLAUDE_CODE_SUBSCRIPTION_TYPE'], 'native filtering still runs').toBeUndefined();
        expect(out['SCRUBBED'], 'the credential-scrub tail ran').toBeUndefined();

        const unscrubbed = runBuilder(builder, env, { scrub: false, denyKey: 'SCRUBBED' });
        expect(unscrubbed['SCRUBBED'], 'the tail is gated on the scrub flag').toBe('secret');
      });

      // New in 2.1.304: the parameter forces the copy path, and the parent env is
      // spread OVER it, so a restored value must win over whatever the base carries.
      it('base-env branch: the restored env wins over a base carrying the injected proxy', () => {
        const parent = injected();
        const out = runBuilder(builder, parent, {
          base: { FROM_BASE: 'yes', HTTPS_PROXY: 'http://127.0.0.1:49653' },
        });
        expect(out['HTTPS_PROXY']).toBe('http://corp-proxy:3128');
        expect(out['NODE_EXTRA_CA_CERTS']).toBeUndefined();
        expect(out[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
        expect(out['FROM_BASE'], 'base-only keys reach the child').toBe('yes');
        expect(parent, 'the parent environment is never mutated').toEqual(injected());
      });

      it('base-env branch: with no contract the parent env still overrides the base', () => {
        const out = runBuilder(builder, { PATH: '/usr/bin', HTTPS_PROXY: 'http://127.0.0.1:49653' }, {
          base: { HTTPS_PROXY: 'http://base:1' },
        });
        expect(out['HTTPS_PROXY']).toBe('http://127.0.0.1:49653');
      });

      it('settings-env branch: reverts the injection and still lays settings on top', () => {
        const out = runBuilder(builder, injected(), { settingsEnv: { FROM_SETTINGS: 'yes' } });
        expect(out['HTTPS_PROXY']).toBe('http://corp-proxy:3128');
        expect(out['NODE_EXTRA_CA_CERTS']).toBeUndefined();
        expect(out[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
        expect(out['FROM_SETTINGS'], 'settings env reaches the child').toBe('yes');
      });

      it('settings-env branch: a settings-level proxy stays authoritative over the revert', () => {
        const out = runBuilder(builder, injected(), {
          settingsEnv: { HTTPS_PROXY: 'http://settings-level:9999' },
        });
        expect(out['HTTPS_PROXY']).toBe('http://settings-level:9999');
        expect(out['NODE_EXTRA_CA_CERTS']).toBeUndefined();
      });

      it('no contract: hands back the parent env untouched', () => {
        const env = { PATH: '/usr/bin', HTTPS_PROXY: 'http://127.0.0.1:49653' };
        const out = runBuilder(builder, env);
        expect(out['HTTPS_PROXY']).toBe('http://127.0.0.1:49653');
        expect(out['PATH']).toBe('/usr/bin');
      });

      const hostile = [
        'not json', '[]', 'null', '{}', '{"version":2,"original":{},"injected":{}}',
        '{"version":1,"original":{"HTTPS_PROXY":1},"injected":{"HTTPS_PROXY":"x"}}',
        '{"version":1,"original":{"__proto__":"x"},"injected":{"__proto__":"y"}}',
      ];
      for (const raw of hostile) {
        it(`hostile contract ${JSON.stringify(raw).slice(0, 46)} never throws and never reverts`, () => {
          const out = runBuilder(builder, {
            PATH: '/usr/bin',
            HTTPS_PROXY: 'http://127.0.0.1:49653',
            [NETWORK_ENV_CONTRACT_VAR]: raw,
          });
          expect(out['HTTPS_PROXY']).toBe('http://127.0.0.1:49653');
          expect(out[NETWORK_ENV_CONTRACT_VAR], 'contract never reaches the child').toBeUndefined();
        });
      }
    });
  }
});
