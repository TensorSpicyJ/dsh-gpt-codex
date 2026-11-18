// Offline regression tests for ownership, settings races and long-lived refresh.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from './index.js';
import { modelsDigest, toModelEntries } from './models.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-refresh-'));
process.env.DSH_HOME = tmp;
process.env.CODEX_HOME = path.join(tmp, 'no-cli');
const cache = path.join(tmp, 'gpt-codex-models.json');
const row = { slug: 'new-model', display_name: 'New', context_window: 100000, visibility: 'list', supported_in_api: true };
const models = toModelEntries({ models: [row] }).models;
const own = () => ({ transport: 'sse', models: structuredClone(models), modelsDigest: modelsDigest(models) });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const drain = () => new Promise((resolve) => setImmediate(resolve));
let passed = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('offline: unexpected fetch'); };

function fixture({ profile = own(), base, config = {}, conflict } = {}) {
  const effects = [];
  const tools = new Map();
  const routes = new Map();
  const state = { profile, base, revision: 0, writes: [], attempts: 0,
    record: { kind: 'grant', payload: { access: 'fixture', refresh: 'fixture-refresh', accountId: 'fixture' } }, credentialWrites: 0 };
  const settings = {
    describe() {
      const raw = state.profile ?? state.base;
      return [{ ns: 'llm-pi-ai', revision: state.revision,
        value: { providers: raw === undefined ? {} : { 'openai-codex': {
          models: [], headers: {}, compat: {}, streamIdleTimeoutMs: 300000,
          ...state.base, ...raw,
        } } },
        base: { providers: state.base === undefined ? {} : { 'openai-codex': state.base } },
        user: { providers: state.profile === undefined ? {} : { 'openai-codex': state.profile } },
      }];
    },
    async mutate(ns, ops, revision) {
      state.attempts++;
      if (conflict && state.attempts === 1) {
        conflict(state);
        state.revision++;
        throw Object.assign(new Error('changed since it was read'), { code: 'SETTINGS_CONFLICT' });
      }
      assert.equal(revision, state.revision);
      state.writes.push(ops);
      state.profile = structuredClone(ops[0].value);
      state.revision++;
    },
  };
  const ctx = {
    effect(fn) { const dispose = fn(); effects.push(dispose); return dispose; },
    get(name) {
      if (name === 'settings') return settings;
      if (name === 'credentials') return {
        async readRecord() { return state.record; },
        async modifyRecord(_key, mutate) { const next = await mutate(state.record); if (next !== undefined) { state.record = next; state.credentialWrites++; } return state.record; },
      };
    },
    inject(names, fn) { if (names.includes('tools')) fn({ effect: ctx.effect, tools: { register(t) { tools.set(t.name, t); return () => {}; } } }); },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
  };
  apply(ctx, { proxy: '', autoEnableRoute: false, autoRefreshModels: false, codexAuthPath: path.join(tmp, 'absent'), ...config });
  return { state, sync: () => tools.get('gpt_models').execute({}),
    async enable() {
      let value;
      await routes.get('/gpt-codex/route/enable')({ method: 'POST' }, { setHeader() {}, end(payload) { value = JSON.parse(payload); } });
      return value;
    },
    dispose() { for (const effect of effects.splice(0).reverse()) if (typeof effect === 'function') effect(); } };
}
const reply = () => new Response(JSON.stringify({ models: [row] }), { headers: { 'content-type': 'application/json' } });
async function check(label, fn) {
  if (process.env.GPT_REFRESH_TEST_FILTER && !label.includes(process.env.GPT_REFRESH_TEST_FILTER)) return;
  await fs.writeFile(cache, JSON.stringify({ fetchedAt: Date.now(), version: 1 }));
  await fn();
  console.log(`  ok  ${label}`); passed++;
}
try {
  for (const custom of [{ maxTokens: 123 }, { compat: { custom: true } }, { input: ['text'], extra: true }]) {
    await check(`custom model fields survive: ${Object.keys(custom).join(',')}`, async () => {
      const profile = own(); Object.assign(profile.models[0], custom);
      const f = fixture({ profile }); globalThis.fetch = async () => reply();
      try { const result = await f.sync(); assert.equal(result.reason, 'profile-not-managed'); assert.equal(f.state.writes.length, 0); assert.deepEqual(f.state.profile, profile); }
      finally { f.dispose(); }
    });
  }
  await check('partial user route never discards inherited custom configuration', async () => {
    const f = fixture({ profile: { transport: 'sse' }, base: { transport: 'websocket', headers: { custom: 'keep' }, retryPolicy: { maxRetries: 7 } } });
    globalThis.fetch = async () => reply();
    try { const result = await f.sync(); assert.equal(result.reason, 'profile-not-managed'); assert.equal(f.state.writes.length, 0); }
    finally { f.dispose(); }
  });
  for (const change of [
    (s) => { s.profile.models = []; },
    (s) => { s.profile.transport = 'websocket'; },
    (s) => { s.profile.retryPolicy = { mode: 'normal', maxRetries: 9 }; },
    (s) => { s.profile.headers = { custom: 'keep' }; },
  ]) {
    await check('network race respects user route edit', async () => {
      const f = fixture(); const started = deferred(); const release = deferred();
      globalThis.fetch = async () => { started.resolve(); await release.promise; return reply(); };
      try { const pending = f.sync(); await started.promise; change(f.state); const edited = structuredClone(f.state.profile); release.resolve(); const result = await pending;
        assert.equal(result.reason, 'profile-not-managed'); assert.deepEqual(f.state.profile, edited); assert.equal(f.state.writes.length, 0); }
      finally { f.dispose(); }
    });
  }
  await check('revision conflict rechecks ownership instead of replaying write', async () => {
    const f = fixture({ profile: { transport: 'sse' }, conflict(s) { s.profile = { transport: 'websocket', models: [{ id: 'pinned' }] }; } });
    globalThis.fetch = async () => reply();
    try { const result = await f.sync(); assert.equal(result.reason, 'profile-not-managed'); assert.equal(f.state.attempts, 1); assert.equal(f.state.writes.length, 0); assert.equal(f.state.profile.transport, 'websocket'); }
    finally { f.dispose(); }
  });
  await check('unrelated revision conflict retries against fresh revision', async () => {
    const f = fixture({ profile: { transport: 'sse' }, conflict() {} }); globalThis.fetch = async () => reply();
    try { const result = await f.sync(); assert.equal(result.applied, true); assert.equal(f.state.attempts, 2); assert.equal(f.state.writes.length, 1); }
    finally { f.dispose(); }
  });
  await check('route enable rechecks user ownership after revision conflict', async () => {
    const f = fixture({ profile: { transport: 'sse' }, conflict(s) { s.profile = { transport: 'websocket', headers: { custom: 'keep' } }; } });
    try { const result = await f.enable(); assert.equal(result.changed, false); assert.equal(result.reason, 'already-configured-differently'); assert.equal(f.state.attempts, 1); assert.equal(f.state.writes.length, 0); }
    finally { f.dispose(); }
  });
  await check('route enable preserves latest generated list after revision conflict', async () => {
    const f = fixture({ profile: { transport: 'sse' }, conflict(s) { s.profile = own(); } });
    try { const result = await f.enable(); assert.equal(result.changed, true); assert.deepEqual(f.state.profile.models, models); assert.equal(f.state.attempts, 2); }
    finally { f.dispose(); }
  });
  for (const replacement of [undefined, { kind: 'grant', payload: { access: 'account-B', accountId: 'B' } }]) {
    await check(`successful fetch discards stale account list after ${replacement ? 'account switch' : 'logout'}`, async () => {
      const f = fixture({ profile: { transport: 'sse' } }); const started = deferred(), release = deferred();
      globalThis.fetch = async () => { started.resolve(); await release.promise; return reply(); };
      try { const pending = f.sync(); await started.promise; f.state.record = replacement; release.resolve();
        const result = await pending; assert.equal(result.code, 'CREDENTIAL_CHANGED'); assert.equal(f.state.writes.length, 0); assert.equal(f.state.credentialWrites, 0); assert.deepEqual(f.state.record, replacement); }
      finally { f.dispose(); }
    });
    await check(`401 refresh cannot resurrect stale account after ${replacement ? 'account switch' : 'logout'}`, async () => {
      const f = fixture(); const started = deferred(), release = deferred(); let calls = 0;
      globalThis.fetch = async (url) => {
        calls++;
        if (String(url).includes('/codex/models')) return new Response('', { status: 401 });
        started.resolve(); await release.promise;
        const access_token = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')}.signature`;
        return new Response(JSON.stringify({ access_token, refresh_token: 'rotated', expires_in: 3600 }));
      };
      try { const pending = f.sync(); await started.promise; f.state.record = replacement; release.resolve();
        const result = await pending; assert.equal(result.code, 'CREDENTIAL_CHANGED'); assert.equal(f.state.credentialWrites, 0); assert.equal(f.state.writes.length, 0); assert.deepEqual(f.state.record, replacement); assert.equal(calls, 2); }
      finally { f.dispose(); }
    });
  }
  await check('account changes during revision conflict discard the fetched catalog', async () => {
    const f = fixture({ profile: { transport: 'sse' }, conflict(s) { s.record = undefined; } }); globalThis.fetch = async () => reply();
    try { const result = await f.sync(); assert.equal(result.code, 'CREDENTIAL_CHANGED'); assert.equal(f.state.attempts, 1); assert.equal(f.state.writes.length, 0); }
    finally { f.dispose(); }
  });
  await check('identical catalog uses raw ownership and does not write defaults', async () => {
    const f = fixture(); globalThis.fetch = async () => reply();
    try { const result = await f.sync(); assert.equal(result.reason, 'unchanged'); assert.equal(f.state.attempts, 0); }
    finally { f.dispose(); }
  });
  await check('manual concurrent refreshes share one fetch', async () => {
    const f = fixture(); const started = deferred(); const release = deferred(); let calls = 0;
    globalThis.fetch = async () => { calls++; started.resolve(); await release.promise; return reply(); };
    try { const a = f.sync(); await started.promise; const b = f.sync(); await drain(); assert.equal(calls, 1); release.resolve(); await Promise.all([a, b]); assert.equal(calls, 1); }
    finally { f.dispose(); }
  });
  await check('due timer updates a long-lived host and schedules its next check', async () => {
    const set = globalThis.setTimeout, clear = globalThis.clearTimeout, now = Date.now;
    const timers = new Map(); let clock = now();
    globalThis.setTimeout = (fn, delay) => { const handle = { unref() {} }; timers.set(handle, { fn, delay }); return handle; };
    globalThis.clearTimeout = (handle) => timers.delete(handle); Date.now = () => clock;
    let f;
    try {
      let calls = 0; globalThis.fetch = async () => { calls++; return reply(); };
      f = fixture({ profile: { transport: 'sse' }, config: { autoRefreshModels: true, modelsRefreshHours: 1 } });
      await drain(); assert.equal(calls, 0); assert.equal(timers.size, 1);
      const [handle, timer] = [...timers][0]; timers.delete(handle); clock += timer.delay; await timer.fn();
      assert.equal(calls, 1); assert.equal(f.state.writes.length, 1); assert.deepEqual(f.state.profile.models, models); assert.equal(timers.size, 1);
      assert.equal([...timers.values()][0].delay, 3600000);
      f.dispose(); assert.equal(timers.size, 0);
    } finally { f?.dispose(); globalThis.setTimeout = set; globalThis.clearTimeout = clear; Date.now = now; }
  });
  await check('long-lived timer checks due cache, retries errors and disposes pending fetch', async () => {
    const set = globalThis.setTimeout, clear = globalThis.clearTimeout, now = Date.now;
    const timers = new Map(); let clock = now(); let id = 0;
    globalThis.setTimeout = (fn, delay) => { const handle = { id: ++id, unref() {} }; timers.set(handle, { fn, at: clock + delay }); return handle; };
    globalThis.clearTimeout = (handle) => timers.delete(handle);
    Date.now = () => clock;
    let f;
    try {
      let calls = 0; let signal; const started = deferred(); const release = deferred();
      globalThis.fetch = async (_url, init) => { calls++; signal = init.signal;
        if (calls === 1) throw new Error('offline');
        started.resolve(); await release.promise; return reply(); };
      f = fixture({ config: { autoRefreshModels: true, modelsRefreshHours: 1 } });
      await drain(); assert.equal(calls, 0); assert.equal(timers.size, 1);
      async function tick() { const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]; assert.ok(next); timers.delete(next[0]); clock = next[1].at; next[1].fn(); await drain(); }
      await tick(); assert.equal(calls, 1); assert.equal(f.state.writes.length, 0); assert.equal(timers.size, 1);
      await tick(); await started.promise; const pending = f.sync(); await drain(); assert.equal(calls, 2);
      f.dispose(); assert.equal(signal.aborted, true); release.resolve(); const result = await pending; await drain();
      assert.equal(result.code, 'ABORTED'); assert.equal(f.state.writes.length, 0); assert.equal(timers.size, 0);
    } finally { f?.dispose(); globalThis.setTimeout = set; globalThis.clearTimeout = clear; Date.now = now; }
  });
  await check('unload before credential read settles causes no route or network write', async () => {
    const f = fixture({ config: { autoRefreshModels: true, autoEnableRoute: true } }); let calls = 0;
    globalThis.fetch = async () => { calls++; return reply(); }; f.dispose(); await drain();
    assert.equal(calls, 0); assert.equal(f.state.writes.length, 0);
  });
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(tmp, { recursive: true, force: true });
}
console.log(`\n${passed} checks passed`);
