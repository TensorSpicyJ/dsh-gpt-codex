/**
 * Keep the `openai-codex` route's model list in step with what the ChatGPT
 * plan actually serves.
 *
 * Why this module exists. pi-ai ships its model catalog as a static file inside
 * the application (`dist/providers/data/openai-codex.json`), and nothing in the
 * harness ever refreshes it: `dsh-llm-pi-ai/src/discovery.ts` deliberately
 * excludes the Codex protocol from its "fetch available models" path, because it
 * authenticates through OAuth and a naive `GET /models` there would report an
 * auth failure as "no models". So a model released after the app was built
 * simply never appears, and a retired one keeps being offered (measured
 * 2026-11-17: `gpt-5.5` and `gpt-5.3-codex-spark` answer
 * `model_not_found`, while `gpt-6.2-sol`/`gpt-6.2-astra`/`gpt-6.1-terra` serve
 * fine but are absent from the 1.3.0 catalog).
 *
 * The service does expose the real list, and Codex CLI uses exactly this call:
 *
 *   GET https://chatgpt.com/backend-api/codex/models?client_version=<x.y.z>
 *   Authorization: Bearer <ChatGPT access token>
 *   ChatGPT-Account-ID: <account id>
 *
 * It answers per account (entitlement scoped), with `slug`, `display_name`,
 * `context_window`, `input_modalities`, `supported_reasoning_levels` and a
 * `visibility` of `list` or `hide`. `client_version` is mandatory — omitting it
 * is a 400 — and it gates the list: an old version sees fewer models.
 *
 * This module only turns that reply into the model entries a route profile
 * carries; the caller owns the settings write.
 */

/** Where the Codex model catalog lives. */
export const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';

/**
 * The version sent as `client_version`.
 *
 * The endpoint gates the catalog on it, so sending an old value hides new
 * models. Codex CLI records the version it last fetched with in
 * `$CODEX_HOME/models_cache.json`; that is the highest version this machine is
 * known to have negotiated, and it is what the CLI itself sends. When no cache
 * exists, fall back to the version this plugin was developed against — new
 * models appear as soon as a newer Codex CLI has recorded one, and the config
 * can override it outright.
 */
export const FALLBACK_CLIENT_VERSION = '0.169.0';

/** pi-ai thinking levels, in its canonical order; anything else is dropped. */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Modalities a route profile may declare. */
const MODALITIES = ['text', 'image'];

/**
 * Read the client version Codex CLI last used, from its own model cache.
 *
 * @param cache - the parsed `models_cache.json`, when the caller already read it.
 * @returns a version string, or `undefined` when the cache does not name one.
 */
export function clientVersionFromCache(cache) {
  const value = cache?.client_version;
  return typeof value === 'string' && /^\d+\.\d+\.\d+/.test(value) ? value : undefined;
}

/**
 * The `client_version` to send, most specific source first.
 *
 * @param options - configured override, and the parsed Codex CLI cache when known.
 * @returns the version string.
 */
export function resolveClientVersion(options = {}) {
  const configured = typeof options.clientVersion === 'string' ? options.clientVersion.trim() : '';
  if (configured !== '') return configured;
  return clientVersionFromCache(options.cache) ?? FALLBACK_CLIENT_VERSION;
}

/**
 * One reasoning level the server lists, as a pi-ai level name.
 *
 * The server spells levels `low`…`max` plus `ultra`, and `ultra` has no pi-ai
 * equivalent (pi-ai's top level is `max`), so it is dropped rather than mapped
 * onto the wrong rung.
 *
 * @param effort - the server's `supported_reasoning_levels[].effort`.
 * @returns the pi-ai level name, or `undefined` when pi-ai cannot express it.
 */
function thinkingLevel(effort) {
  return THINKING_LEVELS.includes(effort) && effort !== 'off' ? effort : undefined;
}

/**
 * The route-profile `reasoningEfforts` for one server entry.
 *
 * `off` is deliberately left undeclared, and that omission is load-bearing. The
 * shipped resolver builds pi-ai's `thinkingLevelMap` level by level: a level the
 * profile *omits* is pinned to `null`, while a level it *declares* carries its
 * wire spelling (and a declared `off: null` is dropped from the map entirely).
 * pi-ai's Codex request builder then reads `map.off !== null` to decide whether
 * to attach a reasoning block when no effort was requested:
 *
 *   profile omits `off`      -> map.off === null      -> send no reasoning -> OK
 *   profile declares `off:`  -> map.off is dropped    -> `{ effort: "none" }` -> HTTP 400
 *   profile sets `off: none` -> map.off === 'none'    -> `{ effort: "none" }` -> HTTP 400
 *
 * Measured 2026-11-17 on `gpt-6.2-sol` and `gpt-6.1-sol`: only the omit form
 * completes a turn, which is why this function never emits an `off` key.
 *
 * Every declared level below is a spelling the server itself listed; `ultra`
 * (server-side only, above pi-ai's `max`) is dropped rather than mislabelled,
 * and a model the server gives no usable level (`gpt-reserve`,
 * `codex-auto-review`) gets `false`, since claiming reasoning pi-ai cannot spell
 * would advertise levels that fail at request time.
 *
 * @param entry - one `models[]` row from the service.
 * @returns a levels dict, or `false` for a non-reasoning model.
 */
export function reasoningEffortsOf(entry) {
  const levels = Array.isArray(entry?.supported_reasoning_levels) ? entry.supported_reasoning_levels : [];
  const declared = {};
  let offered = 0;
  for (const level of levels) {
    const name = thinkingLevel(level?.effort);
    if (name !== undefined) {
      declared[name] = name;
      offered += 1;
    }
  }
  return offered === 0 ? false : declared;
}

/**
 * The modalities a route profile may declare for one server entry.
 *
 * The service lists `audio` on some models; the harness has no audio modality,
 * so only `text`/`image` survive, and an empty intersection falls back to
 * `text` (every served chat model accepts text).
 *
 * @param entry - one `models[]` row from the service.
 * @returns a non-empty modality list.
 */
export function inputOf(entry) {
  const declared = Array.isArray(entry?.input_modalities) ? entry.input_modalities : [];
  const kept = MODALITIES.filter((modality) => declared.includes(modality));
  return kept.length === 0 ? ['text'] : kept;
}

/** A capacity the endpoint reported, or `undefined` when it is not usable. */
function capacity(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}/**
 * The model entries one `/codex/models` reply should become.
 *
 * Only `visibility: "list"` rows survive: the endpoint also returns hidden rows
 * (`gpt-reserve`, `codex-auto-review`) that are routed to internally and are not
 * selectable. Order is the server's own priority order, which is what the model
 * picker should show.
 *
 * @param catalog - the parsed reply (`{ models: [...] }`).
 * @returns `{ models, skipped }` — profile entries, and why rows were dropped.
 */
export function toModelEntries(catalog) {
  const rows = Array.isArray(catalog?.models) ? catalog.models : [];
  const models = [];
  const skipped = [];
  const seen = new Set();
  for (const entry of rows) {
    const id = typeof entry?.slug === 'string' ? entry.slug : '';
    if (id === '') {
      skipped.push({ reason: 'no-slug' });
      continue;
    }
    if (seen.has(id)) {
      skipped.push({ id, reason: 'duplicate' });
      continue;
    }
    if (entry.visibility !== 'list') {
      skipped.push({ id, reason: `visibility-${String(entry.visibility)}` });
      continue;
    }
    if (entry.supported_in_api === false) {
      skipped.push({ id, reason: 'not-in-api' });
      continue;
    }
    const contextWindow = capacity(entry.context_window) ?? capacity(entry.max_context_window);
    if (contextWindow === undefined) {
      // A model with no declared window cannot be sized; inventing 1,000,000
      // would silently truncate requests the server would have accepted.
      skipped.push({ id, reason: 'no-context-window' });
      continue;
    }
    seen.add(id);
    models.push({
      id,
      name: typeof entry.display_name === 'string' && entry.display_name !== '' ? entry.display_name : id,
      contextWindow,
      input: inputOf(entry),
      reasoningEfforts: reasoningEffortsOf(entry),
    });
  }
  return { models, skipped };
}

/**
 * Whether two model entry lists declare the same route catalog.
 *
 * Order-insensitive on purpose: the picker sorts by the route's own order, and a
 * server reordering its priority list must not look like a model change.
 *
 * @param left - one entry list.
 * @param right - the other.
 * @returns true when every entry on either side exists identically on the other.
 */
export function sameModels(left, right) {
  const index = (list) => {
    const map = new Map();
    for (const entry of Array.isArray(list) ? list : []) {
      if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string') {
        map.set(entry.id, stableImage(entry));
      }
    }
    return map;
  };
  const a = index(left);
  const b = index(right);
  if (a.size !== b.size) return false;
  for (const [id, image] of a) {
    if (b.get(id) !== image) return false;
  }
  return true;
}

/** Key-order-insensitive JSON image of one value. */
function stableImage(value) {
  if (Array.isArray(value)) return `[${value.map(stableImage).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableImage(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Reduce a model entry list to exactly the fields this plugin generates.
 *
 * Needed before hashing because a stored profile is not the object that was
 * written: the settings schema materializes defaults inside each entry (an empty
 * `compat` block, for one), so a digest taken over the raw generated list would
 * never match the same list read back from settings — and the "is this list
 * mine?" check would refuse to refresh its own list forever. Keeping only the
 * fields {@link toModelEntries} emits is useful for catalog comparison, but NOT
 * sufficient proof of ownership: the caller must separately reject raw entries
 * that differ from this shape (including hand-set `maxTokens` or `compat`).
 * Host ownership uses the raw `user` projection, not schema-filled `value`.
 *
 * @param models - entry list from generation or from the settings document.
 * @returns the same entries, field by field, in a stable key order.
 */
export function canonicalModels(models) {
  return (Array.isArray(models) ? models : [])
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
    .map((entry) => {
      const efforts = entry.reasoningEfforts;
      return {
        id: entry.id,
        ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
        ...(typeof entry.contextWindow === 'number' ? { contextWindow: entry.contextWindow } : {}),
        ...(Array.isArray(entry.input) && entry.input.length > 0 ? { input: [...entry.input] } : {}),
        ...(efforts === false
          ? { reasoningEfforts: false }
          : efforts !== null && typeof efforts === 'object'
            ? {
                reasoningEfforts: Object.fromEntries(
                  Object.entries(efforts).filter(([, wire]) => typeof wire === 'string').sort(([left], [right]) => left.localeCompare(right)),
                ),
              }
            : {}),
      };
    });
}

/**
 * A short stable digest of one model entry list.
 *
 * A route profile that this plugin generated carries this value beside its
 * `models` list, which is what lets the next sync prove the list is still the
 * generated one. Without that proof the only choices would be "never touch an
 * existing list" (a generated list goes stale forever) or "always overwrite"
 * (a hand-tuned list — a deliberately narrowed set, a pinned older model, a
 * custom `maxTokens` — gets destroyed). FNV-1a over the key-sorted image: 8 hex
 * characters, no dependency, identical on every runtime.
 *
 * Input is passed through {@link canonicalModels} first, so the digest is the
 * same for a list that was just generated and for that list read back after the
 * settings schema filled in its defaults.
 *
 * @param models - the entry list to fingerprint.
 * @returns an 8-character hexadecimal digest.
 */
export function modelsDigest(models) {
  const entries = canonicalModels(models).sort((left, right) => left.id.localeCompare(right.id));
  const text = stableImage(entries);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * What changed between two model entry lists, by id.
 *
 * Reported to the user rather than acted on: an `added` id is a model the plan
 * serves and the route does not offer yet, and a `removed` one is a model the
 * route still offers after the plan dropped it — which is exactly the state that
 * makes a request answer `model_not_found`.
 *
 * @param before - the list currently served by the route.
 * @param after - the list the service reports.
 * @returns `{ added, removed, changed }`, each a list of ids.
 */
export function diffModels(before, after) {
  const index = (list) => {
    const map = new Map();
    for (const entry of Array.isArray(list) ? list : []) {
      if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string') {
        map.set(entry.id, stableImage(entry));
      }
    }
    return map;
  };
  const left = index(before);
  const right = index(after);
  const added = [...right.keys()].filter((id) => !left.has(id));
  const removed = [...left.keys()].filter((id) => !right.has(id));
  const changed = [...right.keys()].filter((id) => left.has(id) && left.get(id) !== right.get(id));
  return { added, removed, changed };
}

/**
 * Ask the service for the account's model catalog.
 *
 * Errors are returned rather than thrown, because every caller is a status or
 * sync path that must report a dead token or an offline machine as a state, not
 * as a crash.
 *
 * @param options - credentials, the client version, and an abort signal.
 * @returns `{ ok: true, catalog, etag }` or `{ ok: false, code, detail }`.
 */
export async function fetchCodexModels(options) {
  const { access, accountId, clientVersion, signal, fetchImpl } = options;
  const doFetch = fetchImpl ?? globalThis.fetch;
  const url = `${MODELS_URL}?client_version=${encodeURIComponent(clientVersion)}`;
  let response;
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${access}`,
        ...(typeof accountId === 'string' && accountId !== '' ? { 'chatgpt-account-id': accountId } : {}),
        originator: 'pi',
        accept: 'application/json',
      },
      signal,
    });
  } catch (error) {
    if (signal?.aborted === true) return { ok: false, code: 'ABORTED', detail: '拉取模型列表被取消' };
    return { ok: false, code: 'NETWORK', detail: `无法连接 Codex 模型列表：${error && error.message ? error.message : String(error)}` };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return {
      ok: false,
      status: response.status,
      code: response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : response.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR',
      detail: `模型列表返回 HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ''}`,
    };
  }
  let catalog;
  try {
    catalog = await response.json();
  } catch (error) {
    return { ok: false, code: 'MALFORMED', detail: `模型列表不是合法 JSON：${error && error.message ? error.message : String(error)}` };
  }
  if (!Array.isArray(catalog?.models)) {
    return { ok: false, code: 'MALFORMED', detail: '模型列表里没有 models 数组' };
  }
  return { ok: true, catalog, etag: response.headers.get('etag') ?? undefined };
}
