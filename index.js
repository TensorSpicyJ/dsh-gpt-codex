/**
 * GPT (ChatGPT / Codex) adapter — Host half.
 *
 * The desktop 0.2.1-rc.5 build already ships everything needed to *talk* to
 * ChatGPT:
 *
 *   - `@deepseek-ai/dsh-llm-pi-ai` mounts dormant (zero routes) in the base
 *     bundle;
 *   - `@earendil-works/pi-ai` carries the `openai-codex` provider at
 *     `https://chatgpt.com/backend-api` with nine chat models;
 *   - `dsh-llm-pi-ai` registers an OAuth authorization flow for it under the
 *     credential record `llm-pi-ai/openai-codex`, and `UNSERVED_OAUTH` excludes
 *     only `openai`, so that flow is real.
 *
 * What is *missing* is the surface and the route:
 *
 *   1. Nothing ever calls `ctx.authorization.begin()` for that key. Searching
 *      the whole installed app finds exactly one caller —
 *      `dsh-deepseek-account-platform` — for DeepSeek's own account. The Models
 *      page hides the API-key field for a keyless native-auth provider and its
 *      `settings.models.sign-in` seat is taken by the DeepSeek account dialog.
 *   2. `llm-pi-ai` has no `openai-codex` route, so even a stored credential
 *      would serve no model.
 *
 * This plugin supplies both and nothing else. It never re-implements token
 * exchange, refresh, or the backend protocol: it writes the record shape
 * `dsh-llm-pi-ai` already reads and adds the provider route through the settings
 * seam, then defers to the shipped adapter for every request.
 *
 * Why the route goes through settings and not this bundle's patch layer: a
 * Cordis patch replaces a matched entry's *whole* config rather than deep
 * merging it, and the profile's own `cordis.patch.yml` already sets
 * `llm-pi-ai`'s providers. A bundle-level patch would therefore be replaced at
 * the profile layer. `ctx.settings.mutate()` is the same write path the Models
 * page uses, and it edits the profile override that actually wins.
 */

import { existsSync, promises as fsp, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  canonicalModels,
  diffModels,
  fetchCodexModels,
  modelsDigest,
  resolveClientVersion,
  sameModels,
  toModelEntries,
} from './models.js';
import { installStreamRepair, resolveRepairEndpoints } from './stream-repair.js';

/** Credential-record scope `dsh-llm-pi-ai` reads and writes. */
const RECORD_SCOPE = 'llm-pi-ai';

/** pi-ai provider id backing ChatGPT subscription traffic. */
const PROVIDER = 'openai-codex';

/** Profile entry id / settings namespace that owns the provider routes. */
const SETTINGS_NS = 'llm-pi-ai';

const API_PREFIX = '/gpt-codex';

/** The credential seam's grammar is a lowercase hyphenated `<scope>/<id>`. */
const RECORD_KEY = `${RECORD_SCOPE}/${PROVIDER}`;

/** pi-ai reads the ChatGPT account id from this namespaced JWT claim. */
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';

/**
 * Where the Codex CLI keeps its own state directory.
 *
 * Mirrors `dsh-home-paths`' rule (trimmed non-empty `$CODEX_HOME`, else `~/.codex`)
 * rather than restating a path.
 */
function codexHome() {
  const configured = process.env.CODEX_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  return path.join(os.homedir(), '.codex');
}

/** Where the Codex CLI keeps its own ChatGPT login. */
function codexAuthFile() {
  return path.join(codexHome(), 'auth.json');
}

/**
 * Where the Codex CLI records the model catalog it last fetched.
 *
 * Read only for one fact: the `client_version` it negotiated, which the models
 * endpoint gates its answer on. Using the CLI's own value means a machine whose
 * Codex is newer than this plugin's fallback still sees every model the CLI sees.
 */
function codexModelsCacheFile() {
  return path.join(codexHome(), 'models_cache.json');
}

/** The parsed Codex CLI model cache, or undefined when absent or unreadable. */
function readCodexModelsCache() {
  const file = codexModelsCacheFile();
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * This plugin's own cache of the last successful model fetch.
 *
 * Lives in the harness home rather than in the workspace: it is machine state,
 * not project data. Written only after a sync that actually reached the service,
 * so it never claims a fetch that did not happen.
 */
function modelsCacheFile() {
  const configured = process.env.DSH_HOME;
  const home = typeof configured === 'string' && configured.trim() !== ''
    ? configured.trim()
    : path.join(os.homedir(), '.dsh');
  return path.join(home, 'gpt-codex-models.json');
}

/** The parsed cache, or undefined when it does not exist or is unreadable. */
function readModelsCache() {
  const file = modelsCacheFile();
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Persist the cache; a failure here must never fail the sync that produced it. */
async function writeModelsCache(value) {
  try {
    await fsp.mkdir(path.dirname(modelsCacheFile()), { recursive: true });
    await fsp.writeFile(modelsCacheFile(), JSON.stringify({ ...value, version: 1 }, null, 2), 'utf8');
  } catch (error) {
    console.warn('[dsh-gpt-codex] 无法写入模型缓存:', error && error.message ? error.message : error);
  }
}

/** How long ago the last successful sync ran, in milliseconds; undefined when never. */
function modelsCacheAge(cache = readModelsCache()) {
  const at = cache?.fetchedAt;
  return typeof at === 'number' && Number.isFinite(at) ? Math.max(0, Date.now() - at) : undefined;
}

function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

/**
 * Decode a JWT payload without verifying it.
 *
 * This is not an authentication decision: the token is already the user's, and
 * chatgpt.com verifies its signature on every request. We read it for the two
 * facts the stored record must carry — the ChatGPT account id and the expiry —
 * which is exactly what pi-ai's own `credentialsFromToken` does.
 */
function decodeJwtPayload(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return undefined;
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Keep untrusted JWT/refresh timestamps finite before they enter JSON records. */
function secondsToMs(seconds) {
  if (typeof seconds !== 'number') return undefined;
  const milliseconds = seconds * 1000;
  return Number.isFinite(milliseconds) ? milliseconds || 0 : undefined;
}

function accountIdFromAccessToken(accessToken) {
  const auth = decodeJwtPayload(accessToken)?.[JWT_CLAIM_PATH];
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
}

/**
 * Translate `~/.codex/auth.json` into the record `dsh-llm-pi-ai` stores for an
 * OAuth grant.
 *
 * pi-ai's credential shape is `{ type: 'oauth', access, refresh, expires,
 * accountId }`; `dsh-llm-pi-ai` wraps it as `{ kind: 'grant', payload }` (see
 * `toRecord`). Writing that shape is how the shipped adapter starts serving the
 * subscription without any token exchange of our own.
 *
 * @returns `{ record, facts }`, or `{ error }` when the file holds no usable
 *   ChatGPT login.
 */
function recordFromCodexAuth(auth) {
  if (!auth || typeof auth !== 'object') return { error: 'auth.json 不是一个对象' };
  const mode = String(auth.auth_mode ?? '');
  const tokens = auth.tokens;
  if (!tokens || typeof tokens !== 'object') {
    return {
      error:
        mode === 'apikey'
          ? 'Codex CLI 当前用的是 API key 登录，不是 ChatGPT 订阅，没有可复用的 OAuth 凭据'
          : 'Codex CLI 的登录文件里没有 OAuth token',
    };
  }
  const access = String(tokens.access_token ?? '');
  const refresh = String(tokens.refresh_token ?? '');
  if (access === '' || refresh === '') return { error: 'Codex CLI 的登录缺少 access 或 refresh token' };

  const payload = decodeJwtPayload(access);
  const accountId = accountIdFromAccessToken(access) ?? (typeof tokens.account_id === 'string' ? tokens.account_id : undefined);
  if (accountId === undefined) return { error: '无法从 access token 里读出厂 ChatGPT 账号 id' };

  const expires = secondsToMs(payload?.exp) ?? Date.now();
  const planType = payload?.[JWT_CLAIM_PATH]?.chatgpt_plan_type;

  return {
    record: { kind: 'grant', payload: { type: 'oauth', access, refresh, expires, accountId } },
    facts: { accountId, expires, ...(typeof planType === 'string' ? { planType } : {}) },
  };
}

/**
 * The OAuth client id and token endpoint pi-ai's Codex flow uses.
 *
 * These are pi-ai's own public constants (`openai-codex.js:18-21`), not a secret:
 * they identify the desktop app to auth.openai.com the same way the Codex CLI
 * does. Restating them here is what lets this plugin refresh a token without
 * importing pi-ai's private module.
 */
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';

/**
 * Reachability of `auth.openai.com` and `chatgpt.com` is not a given.
 *
 * Measured on this machine: both hosts time out on a direct connection and answer
 * normally through the local Clash proxy on 127.0.0.1:7897 — while the Windows
 * *system* proxy switch is off, so nothing inherited it. Node's global `fetch`
 * ignores `HTTP(S)_PROXY` unless `NODE_USE_ENV_PROXY=1` is set at process start,
 * which an already-running desktop app cannot acquire retroactively.
 *
 * The plugin resolves a proxy URL for the global dispatcher. Explicit plugin
 * configuration takes precedence over the process environment; otherwise
 * requests connect directly.
 *
 * @param configured - the plugin's own `proxy` config value, '' for unset.
 * @returns a proxy URL, or undefined to connect directly.
 */
function resolveProxyUrl(configured) {
  const value = String(configured || '').trim();
  if (value !== '') return value;
  const fromEnv = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  // Nothing configured: leave it to the caller. Probing a guessed local port
  // would make every request pay for a connection attempt to nothing.
  return undefined;
}

/**
 * Configure the dispatcher used by pi-ai's global fetch, including when another
 * plugin has already initialized it. Changing NODE_USE_ENV_PROXY at runtime
 * alone does not rebuild that dispatcher. Requires Node >= 24.14.
 *
 * @returns A disposer restoring the previous agents and dispatcher, or undefined
 *   when no proxy was requested. The process environment is left intact.
 */
function installProcessProxy(proxyUrl) {
  if (proxyUrl === undefined) return undefined;
  if (typeof http.setGlobalProxyFromEnv !== 'function') {
    throw new Error('GPT 代理需要 Node.js 24.14 或更新版本；请更新 DeepSeek Harness 桌面版。');
  }
  const bypass = process.env.no_proxy ?? process.env.NO_PROXY ?? '';
  return http.setGlobalProxyFromEnv({
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    no_proxy: [bypass, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(','),
  });
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * Why this exists at all: an access token's `exp` claim is *not* a reliable
 * signal that the server still accepts it. Measured on 2026-11-02, a token with
 * 6.85 days left on `exp` returned 401 from both `api.openai.com/v1/me` and the
 * Codex backend, while the matching refresh token exchanged successfully and the
 * new token worked. So "not expired" and "still authorized" are different facts,
 * and only a refresh (or a real request) tells them apart. Bridging must
 * therefore be willing to refresh up front rather than trust `exp`.
 *
 * @returns `{ access, refresh, expires, accountId, planType }`, or `{ error }`.
 */
async function refreshGrant(refreshToken, signal, proxyUrl) {
  let response;
  try {
    response = await fetch(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID,
      }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted === true) return { error: '刷新被取消' };
    return {
      error: `刷新请求失败：${error && error.message ? error.message : String(error)}${
        proxyUrl === undefined ? '（如果这里直连不上，请在插件配置里设 proxy，例如 http://127.0.0.1:7897）' : `（代理 ${proxyUrl}）`
      }`,
    };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    // 400/401 here means the refresh token itself is dead: the user must sign in
    // again, and saying so is more useful than echoing the endpoint's error body.
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return { error: `refresh token 已失效（HTTP ${response.status}），需要重新登录`, dead: true };
    }
    return { error: `刷新失败（HTTP ${response.status}）${text ? `：${text.slice(0, 200)}` : ''}` };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return { error: '刷新响应不是 JSON' };
  }
  const access = typeof body?.access_token === 'string' ? body.access_token : '';
  const nextRefresh = typeof body?.refresh_token === 'string' ? body.refresh_token : refreshToken;
  if (access === '') return { error: '刷新响应里没有 access_token' };

  const payload = decodeJwtPayload(access);
  const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  if (typeof accountId !== 'string' || accountId === '') return { error: '刷新后的 token 里没有 ChatGPT 账号 id' };
  const now = Date.now();
  const duration = secondsToMs(body?.expires_in);
  const refreshedExpiry = duration === undefined ? undefined : now + duration;
  const expires = Number.isFinite(refreshedExpiry) ? refreshedExpiry : secondsToMs(payload?.exp) ?? now;
  const planType = payload?.[JWT_CLAIM_PATH]?.chatgpt_plan_type;

  return {
    access,
    refresh: nextRefresh,
    expires,
    accountId,
    ...(typeof planType === 'string' ? { planType } : {}),
  };
}

/** The Codex backend and the model a probe asks for. */
const CODEX_BACKEND = 'https://chatgpt.com/backend-api/codex/responses';
const PROBE_MODEL = 'gpt-6.1-sol';

/**
 * Ask the Codex backend for one trivial completion, to learn whether the stored
 * token is actually accepted.
 *
 * Nothing else answers that question. A stored record can be well-formed, its
 * `exp` can be days away, and the backend can still answer 401 — which is exactly
 * what happened here on 2026-11-02. A probe costs one tiny request and turns
 * "configured" into "working".
 *
 * The headers mirror pi-ai's `buildSSEHeaders`
 * (`openai-codex-responses.js:1299-1309`) because the backend distinguishes
 * clients by them; a request without `OpenAI-Beta` and `accept: text/event-stream`
 * is rejected even when the token is fine.
 *
 * @returns `{ ok, status, detail, planType?, code? }`.
 */
async function probeBackend(accessToken, accountId, signal, proxyUrl) {
  const sessionId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let response;
  try {
    response = await fetch(CODEX_BACKEND, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'chatgpt-account-id': accountId,
        originator: 'pi',
        'OpenAI-Beta': 'responses=experimental',
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'session-id': sessionId,
        'x-client-request-id': sessionId,
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        instructions: 'You are a helpful assistant.',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: OK' }] }],
        stream: true,
        store: false,
      }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted === true) return { ok: false, code: 'ABORTED', detail: '探测被取消' };
    return {
      ok: false,
      code: 'NETWORK',
      detail: `无法连接 Codex 后端：${error && error.message ? error.message : String(error)}${
        proxyUrl === undefined ? '（如果这里直连不上，请在插件配置里设 proxy）' : `（代理 ${proxyUrl}）`
      }`,
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return {
      ok: false,
      status: response.status,
      code: response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : response.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR',
      detail: `Codex 后端返回 HTTP ${response.status}${text ? `：${text.slice(0, 300)}` : ''}`,
    };
  }

  // Read only enough of the stream to see a delta or a failure; the probe never
  // needs the whole response.
  let seen = '';
  try {
    const reader = response.body?.getReader?.();
    if (reader !== undefined) {
      const decoder = new TextDecoder();
      let budget = 40;
      while (budget-- > 0) {
        const { done, value } = await reader.read();
        if (done === true) break;
        seen += decoder.decode(value, { stream: true });
        if (seen.includes('response.output_text.delta') || seen.includes('response.completed') || seen.includes('response.failed')) break;
      }
      await reader.cancel().catch(() => void 0);
    }
  } catch (error) {
    if (signal?.aborted === true) return { ok: false, code: 'ABORTED', detail: '探测被取消' };
    return { ok: false, code: 'STREAM', detail: `读取响应失败：${error && error.message ? error.message : String(error)}` };
  }

  if (seen.includes('response.output_text.delta') || seen.includes('response.completed')) {
    return { ok: true, status: response.status, detail: `Codex 后端接受了这次请求（模型 ${PROBE_MODEL}）` };
  }
  if (seen.includes('response.failed')) {
    const match = seen.match(/"message"\s*:\s*"([^"]{0,300})"/);
    return { ok: false, status: response.status, code: 'FAILED', detail: `请求被拒绝：${match ? match[1] : '未说明原因'}` };
  }
  return { ok: false, status: response.status, code: 'EMPTY', detail: '后端返回了空响应' };
}

/** The record's shape plus only the fields that are safe to show. */
function describeRecord(record) {
  if (record === undefined) return { configured: false };
  if (record.kind === 'api-key') return { configured: true, kind: 'api-key' };
  const payload = record.payload ?? {};
  const expires = typeof payload.expires === 'number' && Number.isFinite(payload.expires) ? payload.expires || 0 : undefined;
  return {
    configured: true,
    kind: 'grant',
    ...(typeof payload.type === 'string' ? { type: payload.type } : {}),
    ...(typeof payload.accountId === 'string' ? { accountId: payload.accountId } : {}),
    ...(expires === undefined ? {} : { expires, expired: expires <= Date.now() }),
    hasRefresh: typeof payload.refresh === 'string' && payload.refresh.length > 0,
  };
}

/**
 * Hard requirement: the panel talks to this plugin over its own exact HTTP
 * routes. `tools`, `credentials`, `authorization` and `settings` are read
 * through `ctx.inject`/`ctx.get` so a composition that lacks one still loads.
 */
export const inject = ['webServer'];

export function apply(ctx, rawConfig) {
  const settings = {
    codexAuthPath: rawConfig?.codexAuthPath ? String(rawConfig.codexAuthPath) : '',
    proxy: resolveProxyUrl(rawConfig?.proxy),
    autoEnableRoute: rawConfig?.autoEnableRoute !== false,
    // Extra stream endpoints on top of the Codex backend, for relays that
    // re-serve `openai-codex` from a different base URL.
    endpoints: Array.isArray(rawConfig?.endpoints) ? rawConfig.endpoints : [],
    // Retry `MALFORMED_RESPONSE` on the route this plugin owns: the repair above
    // fixes a reused slot, but a genuinely corrupt argument string can only be
    // recovered by asking the model again.
    retryMalformed: rawConfig?.retryMalformedResponses !== false,
    // Teach the route which models the plan actually serves. An installed
    // pi-ai catalog is a snapshot from build time, so without this a model
    // released later never appears and a retired one stays in the picker.
    manageModels: rawConfig?.manageModels !== false,
    // Re-check on start and while loaded (once per `modelsRefreshHours`), so a new
    // release shows up without anyone pressing a button. Off means the route's
    // model list is only ever changed by an explicit refresh.
    autoRefreshModels: rawConfig?.autoRefreshModels !== false,
    modelsRefreshHours: Number.isFinite(rawConfig?.modelsRefreshHours) && rawConfig.modelsRefreshHours > 0
      ? Number(rawConfig.modelsRefreshHours)
      : 24,
    // Optional pin for the `client_version` the model endpoint gates its answer
    // on. Unset reads the version Codex CLI last negotiated.
    modelsClientVersion: rawConfig?.modelsClientVersion ? String(rawConfig.modelsClientVersion) : '',
  };

  const authFilePath = () => settings.codexAuthPath || codexAuthFile();
  const credentials = () => ctx.get('credentials');
  const settingsService = () => ctx.get('settings');
  let disposed = false;
  const lifetime = new AbortController();
  ctx.effect(() => () => { disposed = true; lifetime.abort(); });

  /** Counters for {@link installStreamRepair}; read by `GET /gpt-codex/stream-repair`. */
  const streamRepairStats = { responses: 0, repairedEvents: 0 };
  const STREAM_REPAIR_VERSION = '0.2.0';

  // ------------------------------------------------------------ provider route ---

  /**
   * Make sure `llm-pi-ai` serves the `openai-codex` route.
   *
   * The route is catalog-backed, so it needs no `models` list: `resolveRouteModels`
   * falls back to the installed catalog, and a profile that names no `apiKeyEnv`
   * authenticates through pi-ai's own credential store — where
   * `llm-pi-ai/openai-codex` lives. The one field this plugin does set is
   * `transport: 'sse'`.
   *
   * Why SSE: pi-ai's Codex WebSocket cache keeps sockets and their idle timers in
   * a module-level map, and nothing in this shipped build calls
   * `closeOpenAICodexWebSocketSessions` — `cleanupSessionResources` has no caller
   * anywhere in the installed app. A finished WebSocket turn therefore keeps the
   * event loop alive, which in a desktop app reads as "answered but never
   * settled". The upstream AITP fork hit the same thing and settled on SSE as its
   * tested default; `auto` may select WebSocket, so it inherits the leak. This is
   * a transport choice only: `api` stays whatever the catalog declares.
   *
   * @returns `{ changed, reason }`; never throws, because a missing settings
   *   service must not break sign-in.
   */
  const ROUTE_PROFILE = { transport: 'sse' };

  /**
   * Codes the shipped default retry policy retries.
   *
   * `dsh-llm` retries EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT and TRANSPORT,
   * and deliberately leaves `MALFORMED_RESPONSE` out (being a `retryChoice` does
   * not add it to the default set). A reused tool-call slot arrives as exactly
   * that code, so without this the whole turn stops on its first attempt — which
   * is what the bug report shows: one bad response, then nothing.
   */
  const DEFAULT_RETRY_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'];

  /** The route profile this plugin recommends, given its configuration. */
  const baseRouteProfile = () => {
    if (!settings.retryMalformed) return { ...ROUTE_PROFILE };
    return {
      ...ROUTE_PROFILE,
      retryPolicy: {
        mode: 'normal',
        maxRetries: 2,
        retryableCodes: [...DEFAULT_RETRY_CODES, 'MALFORMED_RESPONSE'],
      },
    };
  };

  /**
   * The route profile to write, optionally carrying a model list.
   *
   * `modelsDigest` is a marker this plugin owns: it records which list was
   * generated, so a later sync can tell "the list I wrote" from "a list the user
   * wrote or edited". The pi-ai profile schema ignores unknown keys and the
   * settings writer preserves them, which is what makes the marker durable
   * without a separate state file. A user who edits the list through the
   * settings form drops the marker, and that is exactly the signal to stop
   * touching it.
   *
   * @param models - the generated entry list, or undefined for a catalog-backed
   *   route that inherits the installed catalog.
   * @returns the profile value to store.
   */
  const routeProfile = (models) => {
    const base = baseRouteProfile();
    if (!Array.isArray(models) || models.length === 0) return base;
    return { ...base, models, modelsDigest: modelsDigest(models) };
  };

  /** Order-insensitive JSON image, for comparing a stored profile with a target. */
  const stableImage = (value) => {
    if (Array.isArray(value)) return `[${value.map(stableImage).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableImage(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };

  /**
   * Whether a stored profile is one this plugin wrote.
   *
   * Three shapes count: the transport-only route an earlier version wrote, the
   * transport-plus-retry route {@link baseRouteProfile} describes, and either of
   * those plus a model list whose `modelsDigest` still matches its own content.
   * Everything else — another transport, a hand-written retry policy, a pinned
   * or edited model list — belongs to the user and is never overwritten.
   *
   * @param current - the stored provider profile.
   * @returns true when this plugin may rewrite it.
   */
  const isOwnProfile = (current) => {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return false;
    const { models, modelsDigest: marker, ...rest } = current;
    const image = stableImage(rest);
    if (image !== stableImage(baseRouteProfile()) && image !== stableImage(ROUTE_PROFILE)) return false;
    if (models === undefined) return true;
    // A list is ours only while it is still byte-for-byte the list the marker
    // described. Anything edited in place stops being ours.
    return typeof marker === 'string' && Array.isArray(models) && models.length > 0
      // The digest covers generated fields. Reject ANY raw entry additions or
      // edits outside that shape too (maxTokens, compat, null effort values…).
      // Ownership reads `user`, never schema-filled defaults.
      && stableImage(models) === stableImage(canonicalModels(models))
      && marker === modelsDigest(models);
  };

  /** Whether an existing profile is exactly the shape this plugin recommends. */
  const sameProfile = (current, models) => {
    if (current === null || typeof current !== 'object') return false;
    return stableImage(current) === stableImage(routeProfile(models));
  };

  /**
   * Write one provider profile, tolerating a concurrent settings change.
   *
   * `mutate` takes an expected revision, and anything else that edits the
   * `llm-pi-ai` section meanwhile (the Models page, another plugin) makes that
   * revision stale. One re-read is enough: the decision this call makes is
   * re-derived from the fresh descriptor, not replayed.
   *
   * @returns `{ ok: true, revision }` or `{ ok: false, reason }`.
   */
  const writeProviderProfile = async (decide, signal = lifetime.signal, validate) => {
    const service = settingsService();
    if (service === void 0) return { ok: false, reason: 'no-settings-service' };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (validate !== undefined && !await validate()) return { ok: false, reason: 'credential-changed' };
      let descriptor;
      try {
        descriptor = service.describe().find((row) => row.ns === SETTINGS_NS);
      } catch (error) {
        return { ok: false, reason: `describe failed: ${error && error.message ? error.message : String(error)}` };
      }
      if (descriptor === void 0) return { ok: false, reason: 'no-llm-pi-ai-entry' };
      if (disposed || signal.aborted) return { ok: false, reason: 'aborted' };
      // Re-derive both ownership AND the target on every attempt. In particular,
      // a revision conflict is not permission to replay a pre-network decision.
      const decision = decide(profileFromDescriptor(descriptor));
      if (decision.value === undefined) return { ok: true, changed: false, ...decision };
      try {
        await service.mutate(SETTINGS_NS, [{ op: 'set', path: ['providers', PROVIDER], value: decision.value }], descriptor.revision);
        return { ok: true, changed: true, ...decision, revision: descriptor.revision };
      } catch (error) {
        const conflict = error && (error.code === 'SETTINGS_CONFLICT' || /changed since it was read/.test(String(error.message)));
        if (!conflict || attempt === 1) {
          return { ok: false, reason: `mutate failed: ${error && error.message ? error.message : String(error)}` };
        }
      }
    }
    return { ok: false, reason: 'mutate failed: conflicts kept happening' };
  };

  /**
   * The stored `openai-codex` profile, in both shapes the settings service offers.
   *
   * `describe()` returns two different views of the same section, and this plugin
   * needs both:
   *
   *  - `value` is the VALIDATED profile — what `llm-pi-ai` actually serves. It
   *    carries every schema default materialized (`models: []`,
   *    `streamIdleTimeoutMs: 300000`, an empty `compat` block, …), so it answers
   *    "what is served" but can never be compared against the object this plugin
   *    wrote.
   *  - `user` is the profile-layer section exactly as written, projected onto the
   *    schema's fields. That is the shape an ownership test needs: a hand-written
   *    list and a generated one differ there, and only there.
   *
   * Comparing the wrong one is silent and total: `value` never equals the written
   * profile, so every route would look foreign and the plugin would refuse to
   * update its own model list forever.
   *
   * @returns `{ profile, written }` (each possibly undefined) or `{ error }`.
   */
  const profileFromDescriptor = (descriptor) => {
    const profile = descriptor.value?.providers?.[PROVIDER];
    const written = descriptor.user?.providers?.[PROVIDER] ?? profile;
    return {
      profile,
      written,
      configured: profile !== undefined,
      // `base` is validated too. Any inherited provider is deliberately left to
      // its owner: a partial user override must not hide its custom settings.
      managed: descriptor.base?.providers?.[PROVIDER] === undefined && isOwnProfile(written),
    };
  };

  const readStoredProfile = () => {
    const service = settingsService();
    if (service === void 0) return { error: 'no-settings-service' };
    let descriptor;
    try {
      descriptor = service.describe().find((row) => row.ns === SETTINGS_NS);
    } catch (error) {
      return { error: `describe failed: ${error && error.message ? error.message : String(error)}` };
    }
    if (descriptor === void 0) return { error: 'no-llm-pi-ai-entry' };
    return profileFromDescriptor(descriptor);
  };

  const ensureRoute = async (models) => {
    const result = await writeProviderProfile((stored) => {
      const written = stored.written;
      const configured = stored.configured;
      // Preserve a generated list on enable, including after a revision retry.
      const desired = Array.isArray(models) && models.length > 0
        ? models
        : Array.isArray(written?.models) && written.models.length > 0 ? written.models : undefined;
      if (configured && !stored.managed) return { reason: 'already-configured-differently' };
      if (configured && sameProfile(written, desired)) return { reason: 'already-configured' };
      return { value: routeProfile(desired), reason: configured ? 'upgraded' : 'added' };
    });
    return { changed: result.ok && result.changed === true, reason: result.reason };
  };

  /**
   * Keep the route's model list in step with what the plan actually serves.
   *
   * This is the answer to "a new GPT model shipped and the picker still shows the
   * old list". pi-ai's catalog is a JSON file inside the application, written at
   * build time, and `dsh-llm-pi-ai` deliberately does not refresh it for OAuth
   * providers (`discovery.ts` excludes the Codex protocol). So the served list is
   * *configured*: this plugin asks the Codex models endpoint, maps the answer into
   * route entries and writes them into the profile it owns.
   *
   * Who is allowed to be rewritten is the whole safety argument: only a route
   * whose list still matches the marker this plugin wrote is touched. A route the
   * user pinned by hand, narrowed, or edited keeps its list forever, and the
   * report says so (`reason: 'profile-not-managed'`) with the diff attached.
   *
   * @param options - `signal` cancels the fetch.
   * @returns a report: what was fetched, what changed, and what was refused.
   */
  const performModelSync = async (options = {}) => {
    const signal = options.signal;
    const aborted = () => disposed || signal?.aborted;
    const cancelledReport = () => ({ ok: false, code: 'ABORTED', detail: '拉取模型列表被取消' });
    if (aborted()) return cancelledReport();
    const store = credentials();
    if (store === void 0) return { ok: false, code: 'NO_CREDENTIAL_STORE', detail: '没有挂载凭据服务，无法读取 ChatGPT 凭据。' };
    if (!settings.manageModels) return { ok: false, code: 'DISABLED', detail: 'manageModels 已关闭：模型列表交给 llm-pi-ai 的已安装目录。' };
    const record = await store.readRecord(RECORD_KEY);
    if (record === undefined || record.kind !== 'grant') {
      return { ok: false, code: 'NO_CREDENTIAL', detail: '还没有保存 ChatGPT 凭据，无法查询这个账号能用的模型。' };
    }
    // A catalog is account-scoped. A sign-out/sign-in or another grant refresh
    // while the network is pending invalidates this operation, not just its token.
    let credentialImage = stableImage(record);
    const credentialUnchanged = async () => stableImage(await store.readRecord(RECORD_KEY)) === credentialImage;
    const credentialChangedReport = () => ({ ok: false, code: 'CREDENTIAL_CHANGED', detail: '查询期间 ChatGPT 凭据已改变，已丢弃这次模型列表；请重新查询。' });
    let access = typeof record.payload?.access === 'string' ? record.payload.access : '';
    let accountId = typeof record.payload?.accountId === 'string' ? record.payload.accountId : '';
    if (access === '' || accountId === '') {
      return { ok: false, code: 'BAD_RECORD', detail: '凭据记录里没有 access token 或账号 id。' };
    }

    const stored = readStoredProfile();
    if (stored.error !== undefined) return { ok: false, code: 'NO_SETTINGS', detail: stored.error };

    const clientVersion = resolveClientVersion({
      clientVersion: settings.modelsClientVersion,
      cache: readCodexModelsCache(),
    });
    if (aborted()) return cancelledReport();
    let fetched = await fetchCodexModels({ access, accountId, clientVersion, signal });
    if (aborted()) return cancelledReport();

    // A 401 here is the same fact the probe reports: the stored access token can
    // be dead while its `exp` is days away. Refresh once and ask again, which is
    // what keeps a background sync from silently doing nothing for days.
    let refreshedBy = undefined;
    if (fetched.ok !== true && fetched.code === 'UNAUTHORIZED' && typeof record.payload?.refresh === 'string') {
      const refreshed = await refreshGrant(record.payload.refresh, signal, settings.proxy);
      if (aborted()) return cancelledReport();
      if (refreshed.error === undefined) {
        const nextRecord = {
          kind: 'grant',
          payload: {
            type: 'oauth',
            access: refreshed.access,
            refresh: refreshed.refresh,
            expires: refreshed.expires,
            accountId: refreshed.accountId,
          },
        };
        let committed = false;
        await store.modifyRecord(RECORD_KEY, async (current) => {
          // Compare inside the store's atomic mutation, not before acquiring it:
          // logout or account B must never be replaced by account A's refresh.
          if (aborted() || stableImage(current) !== credentialImage) return undefined;
          committed = true;
          return nextRecord;
        });
        if (aborted()) return cancelledReport();
        if (!committed) return credentialChangedReport();
        credentialImage = stableImage(nextRecord);
        access = refreshed.access;
        accountId = refreshed.accountId;
        if (aborted()) return cancelledReport();
        fetched = await fetchCodexModels({ access, accountId, clientVersion, signal });
        refreshedBy = 'refresh';
      }
    }
    if (aborted()) return cancelledReport();
    if (fetched.ok !== true) return { ok: false, ...fetched };
    if (!await credentialUnchanged()) return credentialChangedReport();

    const generated = toModelEntries(fetched.catalog);
    if (generated.models.length === 0) {
      // Writing an empty list would delete the route's whole catalog; reporting
      // it is the only safe outcome.
      return { ok: false, code: 'EMPTY_CATALOG', detail: `模型列表没有可用的条目（跳过 ${generated.skipped.length} 条）。`, skipped: generated.skipped };
    }
    const report = {
      ok: true,
      clientVersion,
      ...(refreshedBy === undefined ? {} : { refreshedBy }),
      fetched: generated.models.length,
      skipped: generated.skipped,
      applied: false,
      reason: 'unchanged',
    };

    /**
     * Record the successful fetch, so the boot pass leaves the network alone
     * until `modelsRefreshHours` passes. Written for a refused write too: asking
     * the service again ten seconds later yields the same refusal, and hammering
     * it is worse than a stale "last checked" time.
     */
    const settle = async () => {
      await writeModelsCache({ clientVersion, etag: fetched.etag, fetchedAt: Date.now(), digest: modelsDigest(generated.models) });
    };

    const written = await writeProviderProfile((latest) => {
      const current = latest.written;
      const currentModels = Array.isArray(current?.models) ? current.models : [];
      // Recompute the report too: a user's in-flight narrowing is the list that
      // matters now, not the one read before the network request.
      const details = currentModels.length === 0 ? {} : { diff: diffModels(currentModels, generated.models) };
      if (latest.configured && !latest.managed) return { reason: 'profile-not-managed', details };
      if (latest.configured && sameModels(currentModels, generated.models)) return { reason: 'unchanged', details };
      return { value: routeProfile(generated.models), reason: latest.configured ? 'models-updated' : 'route-added',
        details: { ...details, ...(currentModels.length === 0 ? { firstSync: true } : {}), digest: modelsDigest(generated.models) } };
    }, signal, credentialUnchanged);
    if (aborted() || written.reason === 'aborted') return cancelledReport();
    if (written.reason === 'credential-changed') return credentialChangedReport();
    if (!written.ok) return { ...report, ok: false, code: 'WRITE_FAILED', detail: written.reason };
    await settle();
    return { ...report, ...written.details, applied: written.changed === true, reason: written.reason };
  };

  // Boot, timer, HTTP and tool callers share one network operation. Unload
  // cancels it even if fetch (or a test double) resolves after aborting.
  let modelSyncPending;
  const syncModels = (options = {}) => {
    if (modelSyncPending !== undefined) return modelSyncPending;
    const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
    modelSyncPending = performModelSync({ signal }).finally(() => { modelSyncPending = undefined; });
    return modelSyncPending;
  };

  // ---------------------------------------------------------------- status ---

  const readStatus = async () => {
    const store = credentials();
    if (store === void 0) {
      return {
        ok: false,
        reason: 'no-credential-store',
        message: '此组合没有挂载凭据服务（dsh-credentials-local），登录结果无处保存。',
      };
    }
    const record = await store.readRecord(RECORD_KEY);
    const file = authFilePath();
    let codexCli = { path: file, present: false };
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
        const bridged = recordFromCodexAuth(parsed);
        codexCli = {
          path: file,
          present: true,
          // Tool outputs cross a lossless-JSON boundary without HTTP's implicit
          // stringify cleanup: unavailable facts must be absent, not undefined.
          ...(typeof parsed.auth_mode === 'string' ? { authMode: parsed.auth_mode } : {}),
          bridgeable: bridged.record !== undefined,
          ...(bridged.error === undefined ? {} : { bridgeError: bridged.error }),
          ...(bridged.facts ?? {}),
        };
      } catch (error) {
        codexCli = { path: file, present: true, error: error && error.message ? error.message : String(error) };
      }
    }

    let route = { configured: false };
    const service = settingsService();
    if (service !== void 0) {
      const stored = readStoredProfile();
      if (stored.error === undefined) {
        const written = stored.written;
        route = {
          configured: stored.configured === true,
          // Whether this route will actually recover from the malformed
          // tool-argument response a reused stream slot produces.
          retriesMalformed: stored.profile?.retryPolicy?.retryableCodes?.includes?.('MALFORMED_RESPONSE') === true,
          // Whether the served model list is one this plugin manages, or a list
          // the user pinned by hand (which is then never overwritten). Read from
          // the written section: `value` carries schema defaults, so it cannot
          // distinguish "no list" from "a list of zero entries".
          ...(stored.configured === true ? { modelsManaged: stored.managed } : {}),
          ...(Array.isArray(written?.models) ? { modelCount: written.models.length } : {}),
        };
      } else {
        route = { configured: false, error: stored.error };
      }
    }

    const authorization = ctx.get('authorization');
    const cache = readModelsCache();
    return {
      ok: true,
      provider: PROVIDER,
      recordKey: RECORD_KEY,
      credential: describeRecord(record),
      codexCli,
      route,
      // What the model-list machinery is doing, and how stale its last answer is.
      models: {
        managed: settings.manageModels,
        autoRefresh: settings.autoRefreshModels,
        refreshHours: settings.modelsRefreshHours,
        clientVersion: resolveClientVersion({ clientVersion: settings.modelsClientVersion, cache: readCodexModelsCache() }),
        ...(modelsCacheAge(cache) === undefined ? {} : { lastSyncAt: cache.fetchedAt, ageSeconds: Math.round(modelsCacheAge(cache) / 1000) }),
        ...(typeof cache?.digest === 'string' ? { digest: cache.digest } : {}),
        cachePath: modelsCacheFile(),
      },
      flowAvailable: authorization?.describe?.(RECORD_KEY) !== undefined,
    };
  };

  /**
   * Status plus a live backend probe.
   *
   * Separate from {@link readStatus} because it costs a network round trip: the
   * page calls it on demand, and the tools call it when the answer matters.
   */
  const verifyStatus = async (signal) => {
    const status = await readStatus();
    if (status.ok !== true) return status;
    const store = credentials();
    const record = await store.readRecord(RECORD_KEY);
    if (record === undefined || record.kind !== 'grant') {
      return { ...status, probe: { ok: false, code: 'NO_CREDENTIAL', detail: '还没有保存 ChatGPT 凭据。' } };
    }
    const access = record.payload?.access;
    const accountId = record.payload?.accountId;
    if (typeof access !== 'string' || typeof accountId !== 'string') {
      return { ...status, probe: { ok: false, code: 'BAD_RECORD', detail: '凭据记录缺少 access token 或账号 id。' } };
    }

    let probe = await probeBackend(access, accountId, signal, settings.proxy);

    // A 401 with a still-valid refresh token is recoverable: refresh once and
    // retry, which is exactly the case measured on this machine.
    if (probe.ok !== true && probe.code === 'UNAUTHORIZED') {
      const refresh = record.payload?.refresh;
      if (typeof refresh === 'string' && refresh !== '') {
        const refreshed = await refreshGrant(refresh, signal, settings.proxy);
        if (refreshed.error === undefined) {
          await commitRecord({
            kind: 'grant',
            payload: {
              type: 'oauth',
              access: refreshed.access,
              refresh: refreshed.refresh,
              expires: refreshed.expires,
              accountId: refreshed.accountId,
            },
          });
          const retried = await probeBackend(refreshed.access, refreshed.accountId, signal, settings.proxy);
          probe = { ...retried, recoveredBy: 'refresh' };
          return { ...(await readStatus()), probe };
        }
        probe = { ...probe, refreshError: refreshed.error };
      }
    }
    return { ...status, probe };
  };

  /** The seam's only write path; this is also what the authorization seam watches. */
  const commitRecord = async (record) => {
    const store = credentials();
    if (store === void 0) throw new Error('没有挂载凭据服务（dsh-credentials-local），无法保存登录结果。');
    await store.modifyRecord(RECORD_KEY, async () => record);
  };

  const seedFromCodexCli = async () => {
    const file = authFilePath();
    if (!existsSync(file)) {
      throw new Error(
        `未找到 Codex CLI 的登录文件：${file}。请先在该机器上完成一次 Codex CLI 的 ChatGPT 登录，或改用浏览器登录。`,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (error) {
      throw new Error(`无法解析 ${file}：${error && error.message ? error.message : String(error)}`);
    }
    const bridged = recordFromCodexAuth(parsed);
    if (bridged.record === undefined) throw new Error(`无法复用 Codex CLI 登录：${bridged.error}`);

    // An access token whose `exp` is still in the future can already be dead
    // server-side (measured), so exchange the refresh token first and store the
    // fresh pair. Falling back to the file's own token when the refresh is
    // unavailable keeps the bridge useful offline; the status page reports which
    // path was taken.
    const refreshed = await refreshGrant(bridged.record.payload.refresh, undefined, settings.proxy);
    const record =
      refreshed.error === undefined
        ? {
            kind: 'grant',
            payload: {
              type: 'oauth',
              access: refreshed.access,
              refresh: refreshed.refresh,
              expires: refreshed.expires,
              accountId: refreshed.accountId,
            },
          }
        : bridged.record;

    await commitRecord(record);
    const route = await ensureRoute();
    return {
      ...(refreshed.error === undefined
        ? {
            accountId: refreshed.accountId,
            expires: refreshed.expires,
            ...(refreshed.planType === undefined ? {} : { planType: refreshed.planType }),
            tokenSource: 'refreshed',
          }
        : { ...bridged.facts, tokenSource: 'codex-cli-file', refreshWarning: refreshed.error }),
      route,
    };
  };

  /**
   * Refresh the stored grant in place.
   *
   * pi-ai also refreshes on its own (inside the credential store's `modify`), but
   * only once it decides a request needs it. Offering an explicit refresh lets a
   * user recover from a token the server revoked early without waiting for a
   * failed model call, and lets this plugin repair what it bridged.
   */
  const refreshStoredGrant = async () => {
    const store = credentials();
    if (store === void 0) throw new Error('没有挂载凭据服务。');
    const current = await store.readRecord(RECORD_KEY);
    if (current === undefined || current.kind !== 'grant') throw new Error('没有可刷新的 ChatGPT 授权记录。');
    const refresh = current.payload?.refresh;
    if (typeof refresh !== 'string' || refresh === '') throw new Error('这条授权记录没有 refresh token，需要重新登录。');
    const refreshed = await refreshGrant(refresh, undefined, settings.proxy);
    if (refreshed.error !== undefined) throw new Error(refreshed.error);
    await commitRecord({
      kind: 'grant',
      payload: {
        type: 'oauth',
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
        accountId: refreshed.accountId,
      },
    });
    return {
      accountId: refreshed.accountId,
      expires: refreshed.expires,
      ...(refreshed.planType === undefined ? {} : { planType: refreshed.planType }),
    };
  };

  /**
   * Drive pi-ai's own OAuth flow through the authorization seam.
   *
   * This is the whole of the "official login" path: `dsh-llm-pi-ai` registered
   * the flow, so this plugin contributes only the interaction surface and the
   * fact that somebody finally calls `begin()`.
   *
   * pi-ai asks two things on this route — which login method (browser vs device
   * code), and, when the loopback callback is unreachable, the pasted code.
   * Neither can be answered without a human, so this in-process caller refuses
   * to guess; the client panel supplies a real interaction instead.
   */
  const signInWithBrowser = async (interaction, signal) => {
    const authorization = ctx.get('authorization');
    if (authorization === void 0) throw new Error('此组合没有挂载授权服务（dsh-authorization），无法发起浏览器登录。');
    if (authorization.describe?.(RECORD_KEY) === undefined) {
      throw new Error(`没有为 ${RECORD_KEY} 注册授权流；确认 llm-pi-ai 已加载。`);
    }
    const outcome = await authorization.begin({ key: RECORD_KEY, signal, interaction });
    if (outcome.status === 'authorized') await ensureRoute();
    return outcome;
  };

  // ------------------------------------------------------------------ tools ---

  ctx.inject(['tools'], (toolCtx) => {
    const register = (definition) => {
      try {
        return toolCtx.effect(() => toolCtx.tools.register(definition));
      } catch (error) {
        console.error('[dsh-gpt-codex] tool registration failed:', definition.name, error);
        return undefined;
      }
    };

    register({
      name: 'gpt_status',
      description:
        '查看「GPT / ChatGPT 订阅」接入状态：是否已保存 ChatGPT 凭据、能否复用本机 Codex CLI 的登录、llm-pi-ai 是否已启用 openai-codex 这条 route，'
        + '并用一次真实请求确认 token 是否真的被后端接受（`verify: true`，默认开启；设为 false 只看本地状态、不联网）。'
        + ' 切换模型到 GPT 或排查 GPT 请求失败前调用。',
      parameters: {
        type: 'object',
        properties: {
          verify: { type: 'boolean', description: '是否向 Codex 后端发一次真实小请求来确认可用，默认 true。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (_args, value) => {
          if (value.ok !== true) return [{ type: 'text', text: `GPT 接入不可用：${value.message}` }];
          const c = value.credential ?? {};
          const lines = [
            'GPT / ChatGPT 接入状态',
            `- provider：${value.provider}（凭据记录 ${value.recordKey}）`,
            `- 凭据：${c.configured ? `已保存（${c.type ?? c.kind}${c.expired ? '，按 exp 已过期' : ''}）` : '未保存'}`,
          ];
          if (c.configured && c.accountId) lines.push(`- ChatGPT 账号：${c.accountId}`);
          const cli = value.codexCli ?? {};
          if (cli.present) {
            lines.push(
              `- Codex CLI 登录（${cli.path}）：${
                cli.bridgeable ? `可复用${cli.planType ? ` · 套餐 ${cli.planType}` : ''}` : `不可复用（${cli.bridgeError ?? cli.error ?? '未知原因'}）`
              }`,
            );
          } else {
            lines.push(`- Codex CLI 登录：未找到（${cli.path}）`);
          }
          lines.push(`- openai-codex route：${value.route?.configured ? '已启用' : '未启用（调用 gpt_sign_in 时会自动补上）'}`);
          if (value.route?.configured) {
            // A route without the retry add-on stops the turn on the first
            // malformed tool-call response; say so instead of leaving the user
            // to rediscover it from a failure message.
            lines.push(
              value.route.retriesMalformed === true
                ? '- 流式工具调用修复：已启用（按 id 纠正被复用位置的并行调用；参数无法解析时重试）'
                : '- 流式工具调用修复：部分启用（按 id 纠正位置；参数无法解析时**不会**重试——调用 POST /gpt-codex/route/enable 可补上）',
            );
          }
          lines.push(`- 浏览器 OAuth 流：${value.flowAvailable ? '已注册，可在面板发起' : '未注册'}`);
          // The served model list, and whether this plugin is the one keeping it
          // current. Without this line a missing new model reads as a broken
          // login rather than as a stale catalog.
          const models = value.models;
          if (models !== undefined) {
            const sync = models.lastSyncAt === undefined
              ? '从未同步过（调用 gpt_models 拉一次）'
              : `${Math.round((models.ageSeconds ?? 0) / 60)} 分钟前同步（client_version ${models.clientVersion}）`;
            lines.push(`- 模型列表：${models.managed ? '由本插件维护' : '交给已安装的 pi-ai 目录'}；${sync}`);
            const route2 = value.route ?? {};
            if (route2.configured && route2.modelsManaged === false) {
              lines.push('  → route 含手写或继承配置，插件不会覆盖；需由配置所有者确认后交回管理。');
            } else if (route2.modelCount !== undefined) {
              lines.push(`  → 当前 route 供 ${route2.modelCount} 个模型。`);
            }
            if (models.managed && models.autoRefresh === true) {
              lines.push(`  → 启动时及每 ${models.refreshHours} 小时自动检查一次（autoRefreshModels）。`);
            } else {
              lines.push(models.managed ? '  → 自动检查已关闭，只在调用 gpt_models 时更新。' : '  → 模型同步已关闭（manageModels:false），保留现有列表。');
            }
          }
          const probe = value.probe;
          if (probe !== undefined) {
            lines.push(
              probe.ok === true
                ? `- 真实请求验证：通过 —— ${probe.detail}${probe.recoveredBy === 'refresh' ? '（token 曾被吊销，已用 refresh token 自动换新）' : ''}`
                : `- 真实请求验证：失败 —— ${probe.detail}${probe.refreshError ? `；尝试刷新也失败：${probe.refreshError}` : ''}`,
            );
            if (probe.ok !== true && probe.code === 'UNAUTHORIZED') {
              lines.push('  → access token 被服务端拒绝。refresh token 若已失效，需要重新走一次登录（gpt_sign_in 或面板里的浏览器登录）。');
            }
          } else {
            // Never let "a record exists" read as "it works": the measured 401
            // happens on a token whose exp is days away.
            lines.push('- 真实请求验证：未做（本次只看本地状态）。凭据存在不等于后端接受；要确认可用请调用 gpt_status（不带 verify:false）。');
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args) {
        return args?.verify === false ? readStatus() : verifyStatus();
      },
    });

    register({
      name: 'gpt_sign_in',
      description:
        '配置「GPT / ChatGPT 订阅」登录，并确保 llm-pi-ai 启用了 openai-codex route。默认 mode=codex-cli：把本机 Codex CLI 已有的 ChatGPT 登录取出来写入 Harness 凭据库（不联网、不重开浏览器）。'
        + ' mode=browser 需要由人在桌面面板里完成浏览器授权，不适合在工具里无人值守调用。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['codex-cli', 'browser'],
            description: '登录方式，默认 codex-cli（复用本机 Codex CLI 登录）。',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (_args, value) => {
          if (value.ok === true) {
            const routeNote = value.route?.changed
              ? '已自动补上 llm-pi-ai 的 openai-codex route'
              : value.route?.reason === 'already-configured'
                ? 'route 早已存在'
                : `route 未改动（${value.route?.reason ?? 'unknown'}）`;
            return [
              {
                type: 'text',
                text: `已写入 ChatGPT 凭据（来源 ${value.source}${value.planType ? ` · 套餐 ${value.planType}` : ''}）。${routeNote}。现在可以把模型切到 GPT。`,
              },
            ];
          }
          return [{ type: 'text', text: `登录未完成：${value.error}` }];
        },
      },
      async execute(args) {
        const mode = args?.mode === 'browser' ? 'browser' : 'codex-cli';
        try {
          if (mode === 'browser') {
            const outcome = await signInWithBrowser({
              notify: () => void 0,
              prompt: () =>
                Promise.reject(
                  new Error('浏览器登录需要人工交互（选择登录方式 / 粘贴授权码），请在桌面面板里操作，或使用 mode=codex-cli。'),
                ),
            });
            return { ok: outcome.status === 'authorized', provider: PROVIDER, source: 'browser-oauth', status: outcome.status };
          }
          const facts = await seedFromCodexCli();
          return {
            ok: true,
            provider: PROVIDER,
            source: 'codex-cli',
            accountId: facts.accountId,
            expires: facts.expires,
            ...(facts.planType === undefined ? {} : { planType: facts.planType }),
            route: facts.route,
          };
        } catch (error) {
          return { ok: false, provider: PROVIDER, error: typeof error?.message === 'string' ? error.message : String(error) };
        }
      },
    });

    register({
      name: 'gpt_sign_out',
      description: '删除本机保存的 ChatGPT 凭据（只删除 Harness 的记录，不向 OpenAI 撤销授权，也不影响 Codex CLI 自己的登录）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (_args, value) =>
          value.ok === true
            ? [{ type: 'text', text: '已删除本机保存的 ChatGPT 凭据。' }]
            : [{ type: 'text', text: `登出失败：${value.error}` }],
      },
      async execute() {
        try {
          const store = credentials();
          if (store === void 0) throw new Error('没有挂载凭据服务。');
          await store.deleteRecord(RECORD_KEY);
          return { ok: true };
        } catch (error) {
          return { ok: false, error: typeof error?.message === 'string' ? error.message : String(error) };
        }
      },
    });
    register({
      name: 'gpt_models',
      description:
        '拉取这个 ChatGPT 账号实际能用的 GPT 模型列表，写进 llm-pi-ai 的 openai-codex route，让模型选择器里的列表保持最新。'
        + '已安装的 pi-ai 目录是打包时的快照：新发布的模型不会自己出现，已下线的模型仍会留在选择器里（选中会报 model_not_found）。'
        + '这个工具向 Codex 的模型接口取权威列表（含上下文窗口与推理档位），合并进 route；route 里手写的 models 不会被覆盖。'
        + ' 想知道"为什么新模型看不到"或刚发布新模型时调用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (_args, value) => {
          if (value.ok !== true) {
            return [{ type: 'text', text: `模型列表没更新：${value.detail ?? value.code ?? '未知原因'}` }];
          }
          const diff = value.diff ?? {};
          const lines = [`已向 Codex 查询模型列表（client_version ${value.clientVersion}），服务端返回 ${value.fetched} 个可用模型。`];
          if (value.firstSync === true) {
            lines.push('- 首次同步：route 之前没有显式模型列表，现在按服务端列表建好了。');
          } else {
            if (diff.added?.length > 0) lines.push(`- 新增：${diff.added.join(', ')}`);
            if (diff.removed?.length > 0) lines.push(`- 移除（服务端已不提供）：${diff.removed.join(', ')}`);
            if (diff.changed?.length > 0) lines.push(`- 元数据变化：${diff.changed.join(', ')}`);
          }
          if (value.applied === true) {
            lines.push(value.reason === 'route-added' ? '- 已写入：route 之前不存在，已按服务端列表建好。' : '- 已写入：模型选择器现在就能看到这个列表。');
          } else if (value.reason === 'profile-not-managed') {
            lines.push('- 未写入：route 含手写、改过或继承的配置，不属于本插件管理；保留原配置。');
          } else if (value.reason === 'unchanged') {
            lines.push('- 未改动：route 里的列表已经和服务端一致。');
          } else {
            lines.push(`- 未写入（${value.reason ?? 'unknown'}）。`);
          }
          if (value.refreshedBy === 'refresh') lines.push('- access token 曾被服务端拒绝，已用 refresh token 换新后重试成功。');
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute() {
        try {
          return await syncModels({});
        } catch (error) {
          return { ok: false, code: 'THREW', detail: typeof error?.message === 'string' ? error.message : String(error) };
        }
      },
    });
  });

  // ------------------------------------------------------------------ routes ---

  const route = (routePath, handler) => {
    try {
      ctx.effect(() =>
        ctx.webServer.register({
          kind: 'exact',
          path: routePath,
          handler: async (req, res) => {
            try {
              await handler(req, res);
            } catch (error) {
              sendJson(res, error && error.statusCode ? error.statusCode : 500, {
                error: { message: error && error.message ? error.message : String(error) },
              });
            }
          },
        }),
      );
    } catch (error) {
      console.error('[dsh-gpt-codex] route registration failed:', routePath, error);
    }
  };

  route(`${API_PREFIX}/status`, async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: { message: 'GET only' } });
    sendJson(res, 200, await readStatus());
  });

  route(`${API_PREFIX}/stream-repair`, async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: { message: 'GET only' } });
    sendJson(res, 200, {
      ok: true,
      version: STREAM_REPAIR_VERSION,
      endpoints: resolveRepairEndpoints(settings.endpoints).map((endpoint) => ({ url: endpoint.url, dialect: endpoint.dialect })),
      ...streamRepairStats,
    });
  });

  /**
   * Status plus a live probe. `?refresh=1` additionally exchanges the refresh
   * token before probing, which is the recovery path when the server revoked an
   * access token early.
   */
  route(`${API_PREFIX}/verify`, async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: { message: 'GET only' } });
    const forceRefresh = typeof req.url === 'string' && req.url.includes('refresh=1');
    if (forceRefresh) {
      try {
        await refreshStoredGrant();
      } catch (error) {
        // A dead refresh token is a real answer, not a crash: report it and let
        // the probe below show the resulting state.
        const message = error && error.message ? error.message : String(error);
        return sendJson(res, 200, { ...(await readStatus()), probe: { ok: false, code: 'REFRESH_FAILED', detail: message } });
      }
    }
    sendJson(res, 200, await verifyStatus());
  });

  route(`${API_PREFIX}/sign-in`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'POST only' } });
    const body = await readJsonBody(req);
    if (body.mode === 'browser') {
      return sendJson(res, 400, {
        error: {
          message: '浏览器登录需要人工交互（选择登录方式、可能在浏览器里完成授权），请在 Exec 面板的「GPT 登录」里发起，或使用 Codex CLI 桥接。',
        },
      });
    }
    const facts = await seedFromCodexCli();
    sendJson(res, 200, { ok: true, provider: PROVIDER, source: 'codex-cli', ...facts });
  });

  route(`${API_PREFIX}/sign-out`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'POST only' } });
    const store = credentials();
    if (store === void 0) throw new Error('没有挂载凭据服务。');
    await store.deleteRecord(RECORD_KEY);
    sendJson(res, 200, { ok: true });
  });

  /**
   * Start the real OAuth flow and hand the browser URL back to the panel.
   *
   * The flow is not resumable across a page reload (the seam keeps attempts in
   * the process that started them), so this is deliberately a fire-and-report
   * call: the attempt runs in the Host, the panel shows the URL and the codes the
   * flow reports, and the outcome is polled from `/oauth/state`.
   */
  let browserAttempt = undefined;
  /** The settled view of the last attempt, kept so the panel can show its outcome. */
  let lastSettledView = { phase: 'idle' };

  route(`${API_PREFIX}/oauth/start`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'POST only' } });
    if (browserAttempt !== undefined) {
      return sendJson(res, 409, {
        error: { message: '已有一次浏览器登录在进行中；先取消它，或稍等它结束。' },
        attempt: browserAttempt.view,
      });
    }

    const attempt = {
      controller: new AbortController(),
      notices: [],
      pending: undefined,
      view: { phase: 'starting', url: undefined, code: undefined, message: undefined },
      done: Promise.resolve(undefined),
    };
    browserAttempt = attempt;
    lastSettledView = { phase: 'idle' };

    const publish = (change) => {
      attempt.view = { ...attempt.view, ...change };
    };

    attempt.done = signInWithBrowser(
      {
        notify: (notice) => {
          attempt.notices.push(notice);
          publish({
            phase: 'waiting',
            url: typeof notice?.url === 'string' ? notice.url : attempt.view.url,
            code: typeof notice?.code === 'string' ? notice.code : attempt.view.code,
            message: typeof notice?.message === 'string' ? notice.message : attempt.view.message,
          });
        },
        prompt: (prompt) => {
          // pi-ai asks: pick a login method, then paste the code if the loopback
          // callback could not be reached. Hand both to the panel and wait.
          return new Promise((resolve, reject) => {
            const settle = {
              resolve: (value) => {
                attempt.pending = undefined;
                resolve(value);
              },
              reject: (error) => {
                attempt.pending = undefined;
                reject(error);
              },
            };
            attempt.pending = { prompt, ...settle };
            publish({
              phase: 'awaiting-input',
              question: {
                kind: typeof prompt?.type === 'string' ? prompt.type : 'text',
                message: typeof prompt?.message === 'string' ? prompt.message : '',
                options: Array.isArray(prompt?.options) ? prompt.options : undefined,
                placeholder: typeof prompt?.placeholder === 'string' ? prompt.placeholder : undefined,
              },
            });
          });
        },
      },
      attempt.controller.signal,
    )
      .then((outcome) => {
        publish({ phase: outcome.status === 'authorized' ? 'authorized' : 'cancelled', question: undefined });
        return outcome;
      })
      .catch((error) => {
        // A user-cancelled attempt is an outcome, not a failure to report loudly.
        const cancelled = attempt.controller.signal.aborted === true;
        publish({
          phase: cancelled ? 'cancelled' : 'failed',
          error: cancelled ? undefined : error && error.message ? error.message : String(error),
          question: undefined,
        });
        return undefined;
      })
      .finally(() => {
        if (browserAttempt === attempt) browserAttempt = undefined;
        lastSettledView = attempt.view;
      });

    // Give the flow a moment to report its first notice (the authorize URL) so a
    // panel that opens right away has something to show.
    await Promise.race([attempt.done, new Promise((resolve) => setTimeout(resolve, 1500))]);
    sendJson(res, 200, { ok: true, attempt: attempt.view });
  });

  route(`${API_PREFIX}/oauth/answer`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'POST only' } });
    const body = await readJsonBody(req);
    const attempt = browserAttempt;
    if (attempt === undefined || attempt.pending === undefined) {
      return sendJson(res, 409, { error: { message: '当前没有等待回答的授权问题。' } });
    }
    const value = body.value === undefined || body.value === null ? '' : String(body.value);
    attempt.pending.resolve(value);
    attempt.pending = undefined;
    sendJson(res, 200, { ok: true });
  });

  route(`${API_PREFIX}/oauth/cancel`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'POST only' } });
    if (browserAttempt !== undefined) {
      const authorization = ctx.get('authorization');
      browserAttempt.controller.abort();
      authorization?.cancel?.(RECORD_KEY);
      browserAttempt.pending?.reject(new Error('用户取消了登录'));
      browserAttempt.pending = undefined;
    }
    sendJson(res, 200, { ok: true });
  });

  route(`${API_PREFIX}/oauth/state`, async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: { message: 'GET only' } });
    sendJson(res, 200, { attempt: browserAttempt?.view ?? lastSettledView });
  });

  route(`${API_PREFIX}/models`, async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: { message: 'GET only' } });
    const stored = readStoredProfile();
    const profile = stored.profile;
    const cache = readModelsCache();
    sendJson(res, 200, {
      ok: true,
      managed: settings.manageModels,
      autoRefresh: settings.autoRefreshModels,
      refreshHours: settings.modelsRefreshHours,
      clientVersion: resolveClientVersion({ clientVersion: settings.modelsClientVersion, cache: readCodexModelsCache() }),
      cachePath: modelsCacheFile(),
      ...(modelsCacheAge(cache) === undefined ? {} : { lastSyncAt: cache.fetchedAt, ageSeconds: Math.round(modelsCacheAge(cache) / 1000) }),
      route: {
        configured: profile !== undefined,
        ...(profile === undefined ? {} : { managed: stored.managed }),
        models: Array.isArray(profile?.models)
          ? profile.models.map((entry) => ({ id: entry.id, name: entry.name, contextWindow: entry.contextWindow }))
          : [],
      },
    });
  });

  /**
   * Refresh the served model list from the Codex models endpoint.
   *
   * The reason this is an explicit route and not only a boot task: the fetch
   * needs the network, may
   * fail, and reports a diff a person wants to read.
   */
  route(`${API_PREFIX}/models/refresh`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'POST only' } });
    const report = await syncModels({});
    sendJson(res, 200, report);
  });

  route(`${API_PREFIX}/route/enable`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'POST only' } });
    sendJson(res, 200, { ok: true, ...(await ensureRoute()) });
  });

  // A stored credential with no route serves nothing; make the common case work
  // without the user having to know that these are two separate facts. The same
  // boot pass is what keeps the model list current: pi-ai's catalog is frozen at
  // build time, so without this a new model would never appear in the picker.
  if (settings.autoEnableRoute || (settings.manageModels && settings.autoRefreshModels)) {
    ctx.effect(() => {
      let cancelled = false;
      let timer;
      const refreshMs = settings.modelsRefreshHours * 3600 * 1000;
      const schedule = () => {
        if (cancelled || disposed || !settings.manageModels || !settings.autoRefreshModels) return;
        const age = modelsCacheAge();
        // Cache-aware scheduling avoids waiting a full period after restarting.
        // Failed checks retry after one period, never in a tight stale-cache loop.
        const delay = age === undefined || age >= refreshMs ? refreshMs : refreshMs - age;
        timer = setTimeout(() => run().finally(schedule), Math.min(delay, 2147483647));
        timer.unref?.();
      };
      const run = async () => {
        const store = credentials();
        if (store === void 0) return;
        let record;
        try {
          record = await store.readRecord(RECORD_KEY);
        } catch (error) {
          console.warn('[dsh-gpt-codex] could not read the stored credential:', error && error.message ? error.message : error);
          return;
        }
        if (cancelled || disposed || record === undefined) return;

        if (settings.autoEnableRoute) {
          try {
            await ensureRoute();
          } catch (error) {
            console.warn('[dsh-gpt-codex] could not enable the openai-codex route:', error && error.message ? error.message : error);
          }
        }

        if (!settings.manageModels || !settings.autoRefreshModels || cancelled) return;
        // Respect the cache: a desktop app restart is not a reason to re-fetch a
        // list that is an hour old, and the endpoint is a live service.
        const age = modelsCacheAge();
        if (age !== undefined && age < settings.modelsRefreshHours * 3600 * 1000) return;
        try {
          const report = await syncModels({});
          if (cancelled) return;
          if (report.applied === true) {
            const added = report.diff?.added ?? [];
            const removed = report.diff?.removed ?? [];
            console.info(
              `[dsh-gpt-codex] 模型列表已更新（${report.fetched} 个模型`
              + `${added.length > 0 ? `；新增 ${added.join(', ')}` : ''}`
              + `${removed.length > 0 ? `；移除 ${removed.join(', ')}` : ''}）`,
            );
          }
        } catch (error) {
          console.warn('[dsh-gpt-codex] could not refresh the model list:', error && error.message ? error.message : error);
        }
      };
      void run().finally(schedule);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }, 'dsh-gpt-codex: enable route and periodically refresh models when a credential exists');
  }

  if (settings.proxy !== undefined) {
    ctx.effect(() => installProcessProxy(settings.proxy), 'dsh-gpt-codex: proxy for the global fetch');
    console.info('[dsh-gpt-codex] 模型请求的运行时代理已启用');
  } else {
    console.info('[dsh-gpt-codex] 没有配置代理；模型请求将直连 auth.openai.com / chatgpt.com');
  }

  // Installed last, so it wraps whatever `fetch` the proxy setup left behind
  // rather than being replaced by it. pi-ai's model requests go through
  // `globalThis.fetch` with no per-request override, which is why a fetch-level
  // wrapper is the only place this repair can live without forking pi-ai.
  const repairEndpointList = resolveRepairEndpoints(settings.endpoints);
  ctx.effect(
    () => installStreamRepair(globalThis, repairEndpointList, streamRepairStats),
    'dsh-gpt-codex: tool-call identity repair for streamed responses',
  );
  console.info(
    `[dsh-gpt-codex] 流式工具调用修复已启用（${repairEndpointList.length} 个端点，按 id 纠正被复用位置的并行调用）`,
  );
}
