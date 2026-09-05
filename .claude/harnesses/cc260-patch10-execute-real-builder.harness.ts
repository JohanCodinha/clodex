// REVIEW HARNESS (not for merge) — Claude Code 2.1.260 PATCH 10 anchor repair.
//
// 2.1.260 changed how the child-env builder READS the remote flag. Through
// 2.1.259 its opening `let` called a helper on it —
// `De(process.env.CLAUDE_CODE_REMOTE)?…` — and 2.1.260 compares a module-level
// env snapshot instead (`i=a.CLAUDE_CODE_REMOTE===!0,l=i?…`). The anchor's head
// spelled the call form, so PATCH 10 (which is required) reported "anchor not
// found" and `clodex patch` refused every one of the eight published builds.
//
// This drives the REAL applyClodexPatches over EVERY REAL 2.1.260 bundle, then
// EXTRACTS the patched builder and EXECUTES it. Reading a regex replacement is
// not evidence the code runs. Every free identifier is bound explicitly and
// recovered from the builder's own text, so a name the harness failed to
// account for surfaces as a ReferenceError rather than passing silently.
//
// `vitest.config.ts` scopes collection to `tests/`, so this file is never
// collected by `pnpm test`. Run it with a throwaway config of your own:
//
//   cat > /tmp/h.config.ts <<'EOC'
//   import { defineConfig } from 'vitest/config';
//   export default defineConfig({ test: { include: ['.claude/harnesses/cc260-*.harness.ts'] } });
//   EOC
//   REVIEW_BUNDLE_DIR=<bundle dir> pnpm vitest run --config /tmp/h.config.ts
//
// To cover all eight platforms, download each build from
// https://downloads.claude.ai/claude-code-releases/2.1.260/<platform>/claude
// (checksums in .../2.1.260/manifest.json), hard-link them into a scratch dir as
// `claude-2.1.260-<platform>.orig`, point TWEAKCC_CONFIG_DIR at it and run
// `node scripts/extract-cc-bundles.mjs <bundle dir>` — the extractor never
// writes to its inputs.
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import vm from 'node:vm';
import { applyClodexPatches } from '../../src/patch-transforms.js';
import { NETWORK_ENV_CONTRACT_VAR } from '../../src/network-env.js';
import { BUNDLE_MODULE_SEPARATOR } from '../../src/bun-bundle.js';
import { EXPECTED_PATCH_SITES } from '../../scripts/probe-patch-sites.mjs';

const BUNDLE_DIR = process.env['REVIEW_BUNDLE_DIR'] ?? '';
const MARKER = '/*ccpatch:child-network-env*/';
// Context and effort are set so every conditional site is exercised; a config with
// only alias/display activates nine of the eleven, and "every patch site" would then
// be a broader title than the assertion.
const CONFIG = {
  'clodex:openai:gpt-5.6-sol': {
    alias: 'sol',
    display: 'GPT-5.6 Sol',
    context: 272000,
    effort: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'high' },
  },
};

function bundles(): string[] {
  if (!BUNDLE_DIR || !existsSync(BUNDLE_DIR)) return [];
  return readdirSync(BUNDLE_DIR)
    .filter(f => /^claude-2\.1\.260-[a-z0-9-]+\.js$/.test(f) && !f.includes('pristine'))
    .sort();
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

/** Every free identifier the 2.1.260 builder reads, recovered from its own text. */
function freeNames(builder: string): Record<string, string> {
  const pick = (label: string, re: RegExp, group = 1): string => {
    const m = builder.match(re);
    expect(m, `could not locate ${label}`).toBeTruthy();
    return m![group]!;
  };
  const hostRegistry = /\}let [\w$]+=([\w$]+)\.of\(([\w$]+)\(\)\.host\)/;
  const denyLists = /,[\w$]+=([\w$]+)\(_clodexChildEnv\),[\w$]+=([\w$]+)\(\),[\w$]+=!1;/;
  const scrubLoop = /if\(![\w$]+\)return [\w$]+;let [\w$]+=([\w$]+)\(\),[\w$]+=([\w$]+)\(\)\.length>0;for\(let\[/;
  const denyTests = /\.replace\(\/-\/g,"_"\)\)\|\|([\w$]+)\.test\([\w$]+\)\|\|([\w$]+)\([\w$]+\)\|\|[\w$]+&&([\w$]+)\([\w$]+\)\)\{delete/;
  const rewrite = /if\(([\w$]+)\([\w$]+\)\)\{let [\w$]+=([\w$]+)\([\w$]+,[\w$]+\);if\([\w$]+\.value!==/;
  const cut = /let [\w$]+=([\w$]+)\([\w$]+,[\w$]+\.value\);if\([\w$]+!==void 0&&!([\w$]+)\(/;
  const normalize = /continue\}let [\w$]+=([\w$]+)\([\w$]+,[\w$]+\);if\([\w$]+===void 0\)\{if\(([\w$]+)\([\w$]+\)\)delete/;
  return {
    // `let e=m.of(B().host)` — the per-host registry and the host resolver.
    registry: pick('host registry', hostRegistry, 1),
    hostOf: pick('host resolver', hostRegistry, 2),
    // 2.1.260: `i=a.CLAUDE_CODE_REMOTE===!0` — the flag is read off a snapshot, not process.env.
    snapshot: pick('env snapshot', /,[\w$]+=([\w$]+)\.CLAUDE_CODE_REMOTE===!0,/),
    remoteEnv: pick('remote env builder', /\.CLAUDE_CODE_REMOTE===!0,[\w$]+=[\w$]+\?([\w$]+)\(/),
    scrubFlag: pick('credential-scrub flag', /,[\w$]+=([\w$]+)\(\),[\w$]+=Object\.keys\(_clodexChildEnv\)\.some\(/),
    upperSet: pick('upper-cased name set', /Object\.keys\(_clodexChildEnv\)\.some\(\(([\w$]+)\)=>([\w$]+)\.has\(\1\.toUpperCase\(\)\)\)/, 2),
    upperPredicate: pick('upper-cased name predicate', /\|\|Object\.keys\(_clodexChildEnv\)\.some\(\(([\w$]+)\)=>([\w$]+)\(\1\.toUpperCase\(\)\)\)/, 2),
    denyList: pick('dynamic deny list', denyLists, 1),
    denyList2: pick('second dynamic deny list', denyLists, 2),
    staticList: pick('static deny list', /;[\w$]+=([\w$]+)\.some\(\([\w$]+\)=>_clodexChildEnv\[/),
    remotePredicate: pick('remote-only key predicate', /,[\w$]+=[\w$]+&&Object\.keys\(_clodexChildEnv\)\.some\(([\w$]+)\)/),
    attributionPredicate: pick(
      'attribution key predicate',
      /,[\w$]+\)\{for\(let ([\w$]+) of Object\.keys\([\w$]+\)\)if\(([\w$]+)\(\1\)\)delete [\w$]+\[\1\]\}if\(/,
      2,
    ),
    scrubList: pick('scrubbed-name list', /new Set\(\[\.\.\.([\w$]+)\(\),"CLAUDE_CODE_SUBSCRIPTION_TYPE"/),
    denySet: pick('scrub deny set', scrubLoop, 1),
    extraList: pick('scrub extra list', scrubLoop, 2),
    proxySentinel: pick('proxy sentinel', /if\([\w$]+===([\w$]+)&&Object\.hasOwn\(/),
    credSentinel: pick('credential sentinel', /==="ANTHROPIC_API_KEY"\)&&[\w$]+===([\w$]+)&&/),
    denyRegex: pick('deny regex', denyTests, 1),
    denyFn: pick('deny predicate', denyTests, 2),
    denyFn2: pick('conditional deny predicate', denyTests, 3),
    keepPredicate: pick('keep predicate', /if\([\w$]+===void 0\|\|([\w$]+)\([\w$]+\)\)continue;/),
    rewritePredicate: pick('rewrite predicate', rewrite, 1),
    rewriter: pick('rewriter', rewrite, 2),
    cutSplit: pick('cut splitter', cut, 1),
    cutHas: pick('cut membership', cut, 2),
    normalizer: pick('normalizer', normalize, 1),
    isSecret: pick('secret predicate', normalize, 2),
  };
}

interface Scenario {
  scrub?: boolean;
  /** Extra keys the static deny list should strip, proving native filtering survives. */
  staticDeny?: string[];
}

function runBuilder(
  patched: string,
  env: Record<string, string>,
  opts: Scenario = {},
): Record<string, string> {
  const builder = patchedBuilderSource(patched);
  const names = freeNames(builder);
  // Two roles recovered to the same identifier would collapse into one binding
  // below; compare the recovered VALUES, not the keys of the bindings object
  // (Object.keys has already deduplicated by then).
  expect(new Set(Object.values(names)).size, 'two roles resolved to one identifier')
    .toBe(Object.keys(names).length);
  const unreachable = (label: string) => () => { throw new Error(`${label} should not run in this scenario`); };
  const bindings: Record<string, unknown> = {
    process: { env },
    [names['registry']!]: { of: () => ({ getAgentProxyEnv: () => ({}), settingsColorEnv: {} }) },
    [names['hostOf']!]: () => ({ host: 'default' }),
    [names['snapshot']!]: {},
    [names['remoteEnv']!]: (x: unknown) => x,
    [names['scrubFlag']!]: () => Boolean(opts.scrub),
    [names['upperSet']!]: new Set<string>(),
    [names['upperPredicate']!]: () => false,
    [names['denyList']!]: () => [],
    [names['denyList2']!]: () => [],
    [names['staticList']!]: opts.staticDeny ?? [],
    [names['remotePredicate']!]: () => false,
    [names['attributionPredicate']!]: () => false,
    [names['scrubList']!]: () => [],
    [names['denySet']!]: () => new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']),
    [names['extraList']!]: () => [],
    [names['proxySentinel']!]: Symbol('proxy-sentinel'),
    [names['credSentinel']!]: Symbol('credential-sentinel'),
    [names['denyRegex']!]: /^(?!)/,
    [names['denyFn']!]: () => false,
    [names['denyFn2']!]: () => false,
    [names['keepPredicate']!]: () => false,
    [names['rewritePredicate']!]: () => false,
    [names['rewriter']!]: unreachable('rewriter'),
    [names['cutSplit']!]: unreachable('cut splitter'),
    [names['cutHas']!]: unreachable('cut membership'),
    [names['normalizer']!]: () => undefined,
    [names['isSecret']!]: () => false,
  };
  const params = Object.keys(bindings);
  const factory = new Function(...params, `return (${builder})`);
  const fn = factory(...params.map(p => bindings[p])) as () => Record<string, string>;
  return fn();
}

const CONTRACT = JSON.stringify({
  version: 1,
  original: { HTTPS_PROXY: 'http://corp-proxy:3128', NODE_EXTRA_CA_CERTS: null },
  injected: { HTTPS_PROXY: 'http://127.0.0.1:49653', NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem' },
});

// Check the PLATFORM ROSTER, not the file count: platform builds of one release
// are minified differently (2.1.260 names this builder Ai/wi/Es/Rs/Ti), so each
// of the eight must be exercised, and hashing rules out one bundle copied eight
// times.
const PLATFORMS = [
  'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-arm64-musl',
  'linux-x64', 'linux-x64-musl', 'win32-arm64', 'win32-x64',
];

describe.runIf(BUNDLE_DIR)('bundle availability', () => {
  it('finds one 2.1.260 bundle per published platform', () => {
    expect(
      PLATFORMS.filter(p => !FILES.some(f => f === `claude-2.1.260-${p}.js`)),
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

describe.skipIf(FILES.length === 0)('Claude Code 2.1.260 — the patched builder, executed', () => {
  for (const file of FILES) {
    describe(file, () => {
      const pristine = readFileSync(join(BUNDLE_DIR, file), 'utf8');
      const patched = applyClodexPatches(pristine, CONFIG).content;

      it('applies every one of the eleven patch sites, PATCH 10 included', () => {
        const out = applyClodexPatches(pristine, CONFIG);
        expect(out.results.map(r => r.name)).toEqual([...EXPECTED_PATCH_SITES]);
        expect(out.results.filter(r => r.status !== 'OK')).toEqual([]);
        expect(out.content.match(/\/\*ccpatch:child-network-env\*\//g)).toHaveLength(1);
      });

      // Since 2.1.242 the bundle is ~1,600 ES modules joined on a boundary line, so a
      // classic-script parse of the whole document fails on the first `import` long
      // before it reaches anything clodex wrote. Parse each CHANGED module as a module
      // instead; `vm.SourceTextModule` needs `NODE_OPTIONS=--experimental-vm-modules`.
      it.skipIf(typeof vm.SourceTextModule !== 'function')(
        'produces modules that still parse as ES modules',
        () => {
          const pristineParts = pristine.split(BUNDLE_MODULE_SEPARATOR);
          const parts = patched.split(BUNDLE_MODULE_SEPARATOR);
          expect(parts.length, 'no module boundary consumed').toBe(pristineParts.length);
          const changed = parts.filter((part, i) => part !== pristineParts[i]);
          expect(changed.length, 'the transforms changed at least one module').toBeGreaterThan(0);
          for (const part of changed) expect(() => new vm.SourceTextModule(part)).not.toThrow();
        },
      );

      it('binds the builder that reads the remote flag off the env snapshot', () => {
        const builder = patchedBuilderSource(patched);
        expect(builder).toContain('.CLAUDE_CODE_REMOTE===!0');
        expect(builder).toContain('settingsColorEnv');
        expect(builder, 'the snapshot read is not a process.env read and must be left alone')
          .not.toContain('_clodexChildEnv.CLAUDE_CODE_REMOTE');
        // No rewritten reference may escape the declaring function.
        expect(patched.split('_clodexChildEnv').length - 1)
          .toBe(builder.split('_clodexChildEnv').length - 1);
      });

      it('early-return branch: reverts to the external proxy and drops the CA + contract', () => {
        const out = runBuilder(patched, {
          PATH: '/usr/bin',
          HTTPS_PROXY: 'http://127.0.0.1:49653',
          NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem',
          [NETWORK_ENV_CONTRACT_VAR]: CONTRACT,
        });
        expect(out['HTTPS_PROXY']).toBe('http://corp-proxy:3128');
        expect(out['NODE_EXTRA_CA_CERTS']).toBeUndefined();
        expect(out[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
        expect(out['PATH']).toBe('/usr/bin');
      });

      it('full-copy branch (credential scrub) also reverts and still scrubs secrets', () => {
        const out = runBuilder(patched, {
          PATH: '/usr/bin',
          ANTHROPIC_API_KEY: 'sk-secret',
          CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
          HTTPS_PROXY: 'http://127.0.0.1:49653',
          NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem',
          [NETWORK_ENV_CONTRACT_VAR]: CONTRACT,
        }, { scrub: true, staticDeny: ['ANTHROPIC_API_KEY'] });
        expect(out['HTTPS_PROXY']).toBe('http://corp-proxy:3128');
        expect(out['NODE_EXTRA_CA_CERTS']).toBeUndefined();
        expect(out[NETWORK_ENV_CONTRACT_VAR]).toBeUndefined();
        expect(out['ANTHROPIC_API_KEY'], 'native filtering still runs').toBeUndefined();
        expect(out['CLAUDE_CODE_OAUTH_TOKEN'], 'credential scrub still runs').toBeUndefined();
        expect(out['PATH']).toBe('/usr/bin');
      });

      it('does NOT revert a value some other layer changed after the injection', () => {
        const out = runBuilder(patched, {
          HTTPS_PROXY: 'http://settings-level:9999',
          NODE_EXTRA_CA_CERTS: '/home/u/.clodex/ca.pem',
          [NETWORK_ENV_CONTRACT_VAR]: CONTRACT,
        });
        expect(out['HTTPS_PROXY'], 'settings override stays authoritative')
          .toBe('http://settings-level:9999');
        expect(out['NODE_EXTRA_CA_CERTS']).toBeUndefined();
      });

      it('no contract: returns the live process.env object, byte-for-byte unchanged', () => {
        const env = { PATH: '/usr/bin', HTTPS_PROXY: 'http://127.0.0.1:49653' };
        expect(runBuilder(patched, env)).toBe(env);
      });

      const hostile = [
        'not json', '[]', 'null', '{}', '{"version":2,"original":{},"injected":{}}',
        '{"version":1,"original":null,"injected":{}}',
        '{"version":1,"original":{"HTTPS_PROXY":1},"injected":{"HTTPS_PROXY":"x"}}',
        '{"version":1,"original":{"HTTPS_PROXY":"a"}}',
        '{"version":1,"injected":{"HTTPS_PROXY":"a"}}',
        '{"version":1,"original":{"__proto__":"x"},"injected":{"__proto__":"y"}}',
        '""', '0',
      ];
      for (const raw of hostile) {
        it(`hostile contract ${JSON.stringify(raw).slice(0, 46)} never throws and never reverts`, () => {
          const out = runBuilder(patched, {
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
