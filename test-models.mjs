/**
 * Unit test for `models.js`: the mapping from the Codex models endpoint to the
 * `llm-pi-ai` route's model entries.
 *
 * The shapes asserted here are not arbitrary — each one is a bug that a plausible
 * implementation would ship:
 *
 *  - `ultra` is a server-side effort level with no pi-ai equivalent. Mapping it
 *    onto `max` (or passing it through) advertises a level that fails at request
 *    time, so it is dropped.
 *  - `off` must not be declared. The shipped resolver pins every *omitted* level
 *    to `null`, and pi-ai's Codex builder sends `{"effort":"none"}` for anything
 *    but `null` — which `gpt-6.1-*`/`gpt-6.2-*` reject with HTTP 400.
 *  - hidden rows (`visibility: "hide"`) are routed to internally and are not
 *    selectable; listing them would put `codex-auto-review` in the model picker.
 *  - the digest must be stable across the settings round trip, because a stored
 *    list comes back with schema defaults materialized inside each entry.
 *
 * Run with `node test-models.mjs`.
 */

import assert from 'node:assert/strict';

const modelsModule = await import('./models.js');
const {
  FALLBACK_CLIENT_VERSION,
  MODELS_URL,
  canonicalModels,
  clientVersionFromCache,
  diffModels,
  fetchCodexModels,
  inputOf,
  modelsDigest,
  reasoningEffortsOf,
  resolveClientVersion,
  sameModels,
  toModelEntries,
} = modelsModule;

const passed = [];
const check = async (label, fn) => {
  await fn();
  passed.push(label);
  console.log(`  ok  ${label}`);
};

/** One server row, shaped like the real endpoint's answer. */
function row(overrides = {}) {
  return {
    slug: 'gpt-6.2-sol',
    display_name: 'GPT-6.2-Sol',
    context_window: 500000,
    max_context_window: 872000,
    input_modalities: ['text', 'image'],
    supported_reasoning_levels: [
      { effort: 'low', display_name: 'Low' },
      { effort: 'medium', display_name: 'Medium' },
      { effort: 'high', display_name: 'High' },
      { effort: 'xhigh', display_name: 'Xhigh' },
      { effort: 'max', display_name: 'Max' },
      { effort: 'ultra', display_name: 'Ultra' },
    ],
    visibility: 'list',
    supported_in_api: true,
    ...overrides,
  };
}

console.log('dsh-gpt-codex model mapping tests');

// ---- 1. a normal row becomes a complete, usable profile entry
{
  const { models, skipped } = toModelEntries({ models: [row()] });
  await check('a listed row becomes an entry with its name, window and modalities', () => {
    assert.equal(skipped.length, 0);
    assert.deepEqual(models, [{
      id: 'gpt-6.2-sol',
      name: 'GPT-6.2-Sol',
      contextWindow: 500000,
      input: ['text', 'image'],
      reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    }]);
  });
}

// ---- 2. `ultra` is dropped rather than mislabelled
{
  await check('ultra has no pi-ai equivalent and is dropped, not mapped to max', () => {
    const efforts = reasoningEffortsOf(row());
    assert.equal(Object.hasOwn(efforts, 'ultra'), false);
    // And `max` keeps its real spelling, so dropping `ultra` did not consume it.
    assert.equal(efforts.max, 'max');
  });
}

// ---- 3. `off` is never declared (the HTTP 400 trap)
{
  await check('reasoningEfforts never declares off, which would send effort:"none"', () => {
    const efforts = reasoningEffortsOf(row());
    assert.equal(Object.hasOwn(efforts, 'off'), false, 'off must stay undeclared');
    // Even when the server itself lists `none`/`off` spellings, they are noise
    // this route cannot express.
    const withNone = reasoningEffortsOf(row({ supported_reasoning_levels: [{ effort: 'none' }, { effort: 'off' }, { effort: 'low' }] }));
    assert.deepEqual(withNone, { low: 'low' });
  });
}

// ---- 4. a model with no expressible level is not advertised as reasoning
{
  await check('a model with no usable level gets reasoningEfforts:false', () => {
    assert.equal(reasoningEffortsOf(row({ supported_reasoning_levels: [] })), false);
    assert.equal(reasoningEffortsOf(row({ supported_reasoning_levels: [{ effort: 'ultra' }] })), false);
    assert.equal(reasoningEffortsOf(row({ supported_reasoning_levels: undefined })), false);
  });
}

// ---- 5. modalities: audio is unsupported by the harness, empty falls back to text
{
  await check('input modalities keep only what the harness models', () => {
    assert.deepEqual(inputOf(row({ input_modalities: ['text', 'image', 'audio'] })), ['text', 'image']);
    assert.deepEqual(inputOf(row({ input_modalities: ['image'] })), ['image']);
    assert.deepEqual(inputOf(row({ input_modalities: ['audio'] })), ['text']);
    assert.deepEqual(inputOf(row({ input_modalities: undefined })), ['text']);
  });
}

// ---- 6. hidden rows never reach the picker
{
  const { models, skipped } = toModelEntries({
    models: [row(), row({ slug: 'gpt-reserve', visibility: 'hide' }), row({ slug: 'codex-auto-review', visibility: 'hide' })],
  });
  await check('visibility:hide rows are skipped with their reason recorded', () => {
    assert.deepEqual(models.map((entry) => entry.id), ['gpt-6.2-sol']);
    assert.deepEqual(skipped, [
      { id: 'gpt-reserve', reason: 'visibility-hide' },
      { id: 'codex-auto-review', reason: 'visibility-hide' },
    ]);
  });
}

// ---- 7. a row with no window is skipped, not silently sized at 1,000,000
{
  const { models, skipped } = toModelEntries({
    models: [row({ slug: 'no-window', context_window: undefined, max_context_window: undefined })],
  });
  await check('a row with no context window is skipped instead of guessed', () => {
    assert.equal(models.length, 0);
    assert.deepEqual(skipped, [{ id: 'no-window', reason: 'no-context-window' }]);
  });
}

// ---- 8. duplicates, missing slugs, and API-only models
{
  const { models, skipped } = toModelEntries({
    models: [
      row(),
      row(), // duplicate slug
      row({ slug: '' }), // no slug
      row({ slug: 'api-only', supported_in_api: false }),
    ],
  });
  await check('duplicates, missing slugs and non-API rows are skipped', () => {
    assert.deepEqual(models.map((entry) => entry.id), ['gpt-6.2-sol']);
    assert.deepEqual(skipped, [
      { id: 'gpt-6.2-sol', reason: 'duplicate' },
      { reason: 'no-slug' },
      { id: 'api-only', reason: 'not-in-api' },
    ]);
  });
}

// ---- 9. an empty or malformed reply yields nothing, never a bogus list
{
  await check('an empty catalog maps to an empty list', () => {
    assert.deepEqual(toModelEntries({ models: [] }), { models: [], skipped: [] });
    assert.deepEqual(toModelEntries({}), { models: [], skipped: [] });
    assert.deepEqual(toModelEntries(undefined), { models: [], skipped: [] });
  });
}

// ---- 10. the digest survives the settings round trip
{
  const generated = toModelEntries({ models: [row()] }).models;
  // What `settings.describe()` returns after validation: defaults materialized.
  const stored = generated.map((entry) => ({
    ...entry,
    maxTokens: 128000,
    compat: { chatTemplateKwargs: {}, chatTemplateArgs: {} },
  }));
  await check('the digest ignores fields the plugin does not generate', () => {
    assert.equal(modelsDigest(generated), modelsDigest(stored), 'a round-tripped list must keep its digest');
    assert.equal(modelsDigest(canonicalModels(generated)), modelsDigest(canonicalModels(stored)));
  });
  await check('the digest changes when the list really changes', () => {
    assert.notEqual(modelsDigest(generated), modelsDigest([]));
    assert.notEqual(modelsDigest(generated), modelsDigest([{ ...generated[0], name: 'Edited' }]));
    assert.notEqual(modelsDigest(generated), modelsDigest([{ ...generated[0], contextWindow: 1 }]));
    assert.notEqual(modelsDigest(generated), modelsDigest([{ ...generated[0], reasoningEfforts: false }]));
  });
  await check('the digest ignores entry order, so a reordered priority list is not a change', () => {
    const first = toModelEntries({ models: [row(), row({ slug: 'b' })] }).models;
    const reordered = toModelEntries({ models: [row({ slug: 'b' }), row()] }).models;
    assert.equal(modelsDigest(first), modelsDigest(reordered));
    assert.equal(sameModels(first, reordered), true);
  });
}

// ---- 11. sameModels / diffModels report what a user needs to read
{
  const before = [{ id: 'a' }, { id: 'retired' }];
  const after = [{ id: 'a' }, { id: 'new' }];
  await check('diffModels names added, removed and changed ids', () => {
    assert.deepEqual(diffModels(before, after), { added: ['new'], removed: ['retired'], changed: [] });
    assert.deepEqual(diffModels(after, after), { added: [], removed: [], changed: [] });
    assert.deepEqual(diffModels(undefined, after), { added: ['a', 'new'], removed: [], changed: [] });
    assert.deepEqual(
      diffModels([{ id: 'a', contextWindow: 1 }], [{ id: 'a', contextWindow: 2 }]),
      { added: [], removed: [], changed: ['a'] },
    );
  });
  await check('sameModels compares content, not identity or order', () => {
    assert.equal(sameModels([{ id: 'a', n: 1 }], [{ n: 1, id: 'a' }]), true);
    assert.equal(sameModels([{ id: 'a', n: 1 }], [{ id: 'a', n: 2 }]), false);
    assert.equal(sameModels([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }]), false);
    assert.equal(sameModels(undefined, []), true);
  });
}

// ---- 12. the client version: configured override, then the Codex CLI cache
{
  await check('the client version prefers an explicit setting over the CLI cache', () => {
    assert.equal(resolveClientVersion({ clientVersion: '0.200.0', cache: { client_version: '0.169.0' } }), '0.200.0');
    assert.equal(resolveClientVersion({ clientVersion: '  ', cache: { client_version: '0.169.0' } }), '0.169.0');
    assert.equal(resolveClientVersion({ cache: { client_version: '0.150.0' } }), '0.150.0');
    assert.equal(resolveClientVersion({}), FALLBACK_CLIENT_VERSION);
    assert.equal(resolveClientVersion({ cache: { client_version: 'not-a-version' } }), FALLBACK_CLIENT_VERSION);
    assert.equal(clientVersionFromCache({ client_version: '0.169.0' }), '0.169.0');
    assert.equal(clientVersionFromCache({}), undefined);
  });
}

// ---- 13. the fetch call itself: URL, headers, and every failure shape
{
  const calls = [];
  const reply = (response) => async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  const json = (body, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  await check('fetchCodexModels sends the documented request', async () => {
    const result = await fetchCodexModels({
      access: 'token',
      accountId: 'acct',
      clientVersion: '0.169.0',
      fetchImpl: reply(json({ models: [row()] }, 200, { etag: 'W/"abc"' })),
    });
    assert.equal(result.ok, true);
    assert.equal(result.etag, 'W/"abc"');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${MODELS_URL}?client_version=0.169.0`);
    assert.equal(calls[0].init.headers.authorization, 'Bearer token');
    assert.equal(calls[0].init.headers['chatgpt-account-id'], 'acct');
    // `client_version` is mandatory server-side: a 400 without it is the
    // documented behaviour, so it must never be omitted.
    assert.match(calls[0].url, /client_version=0\.169\.0/);
  });

  await check('fetchCodexModels reports auth, rate-limit and network failures as states', async () => {
    const unauthorized = await fetchCodexModels({ access: 't', accountId: 'a', clientVersion: '1.0.0', fetchImpl: reply(json({ detail: 'no' }, 401)) });
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.code, 'UNAUTHORIZED');

    const limited = await fetchCodexModels({ access: 't', accountId: 'a', clientVersion: '1.0.0', fetchImpl: reply(json({}, 429)) });
    assert.equal(limited.code, 'RATE_LIMITED');

    const broken = await fetchCodexModels({ access: 't', accountId: 'a', clientVersion: '1.0.0', fetchImpl: reply(new Response('<html>', { status: 502 })) });
    assert.equal(broken.ok, false);
    assert.equal(broken.code, 'HTTP_ERROR');
    assert.match(broken.detail, /502/);

    const offline = await fetchCodexModels({
      access: 't', accountId: 'a', clientVersion: '1.0.0',
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    assert.equal(offline.code, 'NETWORK');
    assert.match(offline.detail, /ECONNREFUSED/);
  });

  await check('fetchCodexModels refuses a body with no models array', async () => {
    const notJson = await fetchCodexModels({ access: 't', accountId: 'a', clientVersion: '1.0.0', fetchImpl: reply(new Response('nope', { status: 200 })) });
    assert.equal(notJson.code, 'MALFORMED');
    const noArray = await fetchCodexModels({ access: 't', accountId: 'a', clientVersion: '1.0.0', fetchImpl: reply(json({ data: [] })) });
    assert.equal(noArray.code, 'MALFORMED');
  });

  await check('fetchCodexModels reports a cancelled request as ABORTED', async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = await fetchCodexModels({
      access: 't', accountId: 'a', clientVersion: '1.0.0', signal: controller.signal,
      fetchImpl: async () => { throw new Error('aborted'); },
    });
    assert.equal(aborted.code, 'ABORTED');
  });
}

console.log(`\n${passed.length} checks passed`);
