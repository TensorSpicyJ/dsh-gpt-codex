/**
 * GPT (ChatGPT / Codex) adapter — Client half.
 *
 * A settings page that answers one question and offers the two actions the Host
 * half exposes: bridge the local Codex CLI login, or run the built-in OAuth flow.
 *
 * It talks to its own Host routes (`/gpt-codex/...`) with same-origin `fetch`;
 * the client bundle has no filesystem, no `host`, and no `ctx.remote` namespace
 * of its own, so HTTP is the only channel. Everything stateful — the credential
 * record, the OAuth attempt — lives in the Host.
 */

window.__ModuleLoader__.load({
  id: 'dsh-gpt-codex',
  factory(require) {
    const React = require('react');

    const API = '/gpt-codex';

    const call = async (pathname, options) => {
      const response = await fetch(`${API}${pathname}`, {
        method: options?.method ?? 'GET',
        headers: options?.body === undefined ? {} : { 'content-type': 'application/json' },
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await response.text();
      let value;
      try {
        value = text ? JSON.parse(text) : {};
      } catch {
        value = { error: { message: text } };
      }
      if (!response.ok) {
        const message = value?.error?.message ?? `HTTP ${response.status}`;
        throw new Error(message);
      }
      return value;
    };

    const formatTime = (milliseconds) => {
      if (typeof milliseconds !== 'number') return undefined;
      const date = new Date(milliseconds);
      if (Number.isNaN(date.getTime())) return undefined;
      return `${date.toLocaleString()}（${date.getTime() > Date.now() ? '有效' : '已过期'}）`;
    };

    /**
     * A coarse age ("3 分钟", "2 小时"), for a cache timestamp.
     *
     * Deliberately not an exact timestamp: what the reader needs to know is
     * whether the model list was checked recently enough to trust.
     */
    const formatAge = (seconds) => {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '—';
      if (seconds < 90) return '刚刚';
      if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
      if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时`;
      return `${Math.round(seconds / 86400)} 天`;
    };

    const styles = {
      page: {
        padding: '24px 28px',
        height: '100%',
        overflow: 'auto',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        boxSizing: 'border-box',
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 8,
        padding: '16px 18px',
        marginBottom: 14,
        maxWidth: 760,
      },
      title: { fontSize: 16, fontWeight: 600, margin: '0 0 10px' },
      row: { display: 'flex', gap: 8, alignItems: 'baseline', margin: '6px 0', fontSize: 13, lineHeight: 1.6 },
      label: { color: 'var(--dsw-alias-label-secondary)', minWidth: 132, flex: '0 0 auto' },
      value: { wordBreak: 'break-all' },
      hint: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.7, margin: '10px 0 0' },
      buttons: { display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' },
      button: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 6,
        padding: '7px 14px',
        fontSize: 13,
        cursor: 'pointer',
      },
      primary: {
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        borderRadius: 6,
        padding: '7px 14px',
        fontSize: 13,
        cursor: 'pointer',
      },
      danger: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary))',
        borderRadius: 6,
        padding: '7px 14px',
        fontSize: 13,
        cursor: 'pointer',
      },
      error: { color: 'var(--dsw-alias-state-error-primary, #d93025)', fontSize: 13, margin: '10px 0 0' },
      ok: { color: 'var(--dsw-alias-state-success-primary, var(--dsw-alias-label-primary))', fontSize: 13, margin: '10px 0 0' },
      badge: (tone) => ({
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: 10,
        fontSize: 12,
        border: '1px solid var(--dsw-alias-border-l1)',
        color: tone === 'on' ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
      }),
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 6,
        padding: '7px 10px',
        fontSize: 13,
        width: '100%',
        boxSizing: 'border-box',
        marginTop: 8,
      },
    };

    function Row(props) {
      return React.createElement(
        'div',
        { style: styles.row },
        React.createElement('span', { style: styles.label }, props.label),
        React.createElement('span', { style: styles.value }, props.children),
      );
    }

    function GptSection() {
      const [status, setStatus] = React.useState(undefined);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [message, setMessage] = React.useState('');
      const [messageTone, setMessageTone] = React.useState('success');
      const [attempt, setAttempt] = React.useState(undefined);
      const [answer, setAnswer] = React.useState('');
      const [probe, setProbe] = React.useState(undefined);
      const [apiKeyProbe, setApiKeyProbe] = React.useState(undefined);

      const refresh = React.useCallback(async () => {
        try {
          setStatus(await call('/status'));
          setError('');
        } catch (failure) {
          setError(failure.message);
        }
      }, []);

      React.useEffect(() => {
        void refresh();
      }, [refresh]);

      // Poll while an OAuth attempt is live; the flow reports notices
      // asynchronously and the seam keeps the attempt in this process.
      React.useEffect(() => {
        let timer;
        let stopped = false;
        const tick = async () => {
          if (stopped) return;
          try {
            const state = await call('/oauth/state');
            if (stopped) return;
            setAttempt(state.attempt);
            if (state.attempt && state.attempt.phase !== 'idle') {
              timer = setTimeout(tick, 1200);
              return;
            }
          } catch {
            /* a transient read failure must not stop the page */
          }
          timer = setTimeout(tick, 4000);
        };
        timer = setTimeout(tick, 800);
        return () => {
          stopped = true;
          if (timer) clearTimeout(timer);
        };
      }, []);

      const run = async (label, action) => {
        setBusy(label);
        setError('');
        setMessage('');
        try {
          const result = await action();
          setMessage(typeof result === 'string' ? result : result.text);
          setMessageTone(typeof result === 'string' ? 'success' : result.tone);
          await refresh();
        } catch (failure) {
          setError(failure.message);
        } finally {
          setBusy('');
        }
      };

      const bridge = () =>
        run('bridge', async () => {
          const result = await call('/sign-in', { method: 'POST', body: { mode: 'codex-cli' } });
          const routeNote =
            result.route?.changed === true
              ? result.route?.reason === 'upgraded'
                ? '已把旧版 route 升级（补上 MALFORMED_RESPONSE 重试）。'
                : '已自动补上 openai-codex 这条 route。'
              : result.route?.reason === 'already-configured'
                ? 'route 早已存在。'
                : `route 未改动（${result.route?.reason ?? 'unknown'}）。`;
          return `已从 Codex CLI 复用 ChatGPT 登录${result.planType ? `（套餐 ${result.planType}）` : ''}。${routeNote} 现在可以把模型切到 GPT。`;
        });

      const startOauth = () =>
        run('oauth', async () => {
          const result = await call('/oauth/start', { method: 'POST', body: {} });
          setAttempt(result.attempt);
          return '已发起浏览器登录，请按下方提示操作。';
        });

      const cancelOauth = () =>
        run('cancel', async () => {
          await call('/oauth/cancel', { method: 'POST', body: {} });
          setAttempt(undefined);
          return '已取消登录。';
        });

      const submitAnswer = () =>
        run('answer', async () => {
          await call('/oauth/answer', { method: 'POST', body: { value: answer } });
          setAnswer('');
          return '已提交。';
        });

      const signOut = () =>
        run('signout', async () => {
          await call('/sign-out', { method: 'POST', body: {} });
          return '已删除本机保存的 ChatGPT 凭据（不影响 Codex CLI 自己的登录）。';
        });

      const enableRoute = () =>
        run('route', async () => {
          const result = await call('/route/enable', { method: 'POST', body: {} });
          if (result.changed !== true) return `route 未改动（${result.reason}）。`;
          return result.reason === 'upgraded' ? '已给这条 route 补上 MALFORMED_RESPONSE 重试。' : '已启用 openai-codex route。';
        });

      /**
       * Ask the Host to re-read the model list from the Codex endpoint.
       *
       * The installed pi-ai catalog is a build-time snapshot. This manual check
       * complements the Host's startup and periodic checks for OAuth routes.
       */
      const refreshModels = () =>
        run('models', async () => {
          const result = await call('/models/refresh', { method: 'POST', body: {} });
          if (result.ok !== true) throw new Error(`模型列表未更新 —— ${result.detail ?? result.code ?? '未知原因'}`);
          if (result.reason === 'profile-not-managed') {
            return { text: `已查到 ${result.fetched} 个模型；route 为自定义或继承配置，已保留，没有覆盖。`, tone: 'neutral' };
          }
          if (result.applied === true) {
            const change = result.firstSync === true
              ? '首次同步。'
              : [
                  ['added', '新增'],
                  ['removed', '移除'],
                  ['changed', '更新参数'],
                ].map(([key, label]) => result.diff?.[key]?.length > 0 ? ` ${label} ${result.diff[key].join('、')}。` : '').join('');
            return `已拉取 ${result.fetched} 个模型并写入 route。${change}`;
          }
          if (result.reason === 'unchanged') return `已检查，route 里的模型列表已是最新（${result.fetched} 个）。`;
          return { text: `已查到 ${result.fetched} 个模型，但未写入 route（${result.reason ?? '未知原因'}）。`, tone: 'neutral' };
        });

      /**
       * Ask the Host to send one real request. "Configured" is not "working":
       * a stored token can be revoked while its `exp` is still days away.
       */
      const verify = (forceRefresh) =>
        run(forceRefresh ? 'refresh' : 'verify', async () => {
          const result = await call(`/verify${forceRefresh ? '?refresh=1' : ''}`);
          setProbe(result.probe);
          await refresh();
          const detail = result.probe?.detail ?? '没有拿到探测结果';
          if (result.probe?.ok === true) {
            return `真实请求验证通过 —— ${detail}${result.probe.recoveredBy === 'refresh' ? '（token 曾被吊销，已自动换新）' : ''}`;
          }
          return `真实请求验证失败 —— ${detail}`;
        });

      /**
       * Verify the key the route in force actually uses.
       *
       * The Host decides which destination that is, and refuses to send anything
       * when the route points at a relay or binds another reference — this handler
       * only prints what came back.
       */
      const verifyApiKey = () =>
        run('verify-key', async () => {
          const result = await call('/api-key/verify');
          setApiKeyProbe(result.probe);
          return result.probe?.ok === true
            ? `API key 验证通过 —— ${result.probe.detail}`
            : `API key 验证失败 —— ${result.probe?.detail ?? '没有拿到结果'}`;
        });

      const enableApiKeyRoute = () =>
        run('key-route', async () => {
          const result = await call('/api-key/route', { method: 'POST', body: {} });
          return result.changed ? '已启用 openai route（API key）。' : `route 未改动（${result.reason}）。`;
        });

      if (status === undefined) {
        return React.createElement(
          'div',
          { style: styles.page },
          React.createElement('h1', { style: { fontSize: 20, margin: '0 0 14px' } }, 'GPT 接入'),
          React.createElement('p', { style: styles.hint }, error === '' ? '正在读取状态…' : `读取失败：${error}`),
        );
      }

      const credential = status.credential ?? {};
      const cli = status.codexCli ?? {};
      const route = status.route ?? {};
      const models = status.models ?? {};
      const key = status.apiKey ?? {};
      // An omitted list inherits the installed catalog; it is not an empty list.
      const hasModelCount = Number.isInteger(route.modelCount) && route.modelCount >= 0;
      const modelSource = hasModelCount
        ? `${route.modelCount} 个模型${route.modelsManaged === false ? '（自定义/继承配置，保留）' : ''}`
        : route.configured ? '沿用已安装模型目录（数量未知）' : 'route 未启用';
      const age = formatAge(models.ageSeconds);
      const lastCheck = models.lastSyncAt === undefined
        ? '尚未检查'
        : age === '刚刚' ? '刚刚检查' : age === '—' ? '已检查（时间未知）' : `${age}前检查`;
      const autoRefresh = models.managed === false
        ? '已关闭模型管理；保留现有列表'
        : models.autoRefresh === false
          ? '自动更新已关闭；可手动更新'
          : models.managed === true && models.autoRefresh === true
            ? `启动时及每 ${models.refreshHours} 小时检查${!credential.configured ? ' · 等待登录' : ''}${route.modelsManaged === false ? ' · 自定义/继承配置不会覆盖' : ''}`
            : '自动更新状态未知';
      const attemptPhase = attempt?.phase ?? 'idle';
      const question = attempt?.question;

      return React.createElement(
        'div',
        { style: styles.page },
        React.createElement('h1', { style: { fontSize: 20, margin: '0 0 6px' } }, 'GPT 接入'),
        React.createElement(
          'p',
          { style: { ...styles.hint, marginTop: 0 } },
          '两条独立的路都能把 GPT 接进这个桌面版：一条用 ChatGPT 订阅（pi-ai 的 openai-codex，需要登录），一条用 OpenAI Platform 的 API key（标准按量计费，不需要订阅）。两条可以同时开着，切模型时各选各的。',
        ),

        React.createElement(
          'div',
          { style: styles.card },
          React.createElement('h2', { style: styles.title }, '当前状态'),
          React.createElement(
            Row,
            { label: 'ChatGPT 凭据' },
            credential.configured
              ? React.createElement(
                  'span',
                  null,
                  React.createElement('span', { style: styles.badge('on') }, '已保存'),
                  ` ${credential.type ?? credential.kind}`,
                  credential.expired ? ' · access token 已过期，下次请求时自动刷新' : '',
                )
              : React.createElement('span', { style: styles.badge('off') }, '未保存'),
          ),
          credential.accountId ? React.createElement(Row, { label: '账号' }, credential.accountId) : null,
          credential.expires
            ? React.createElement(Row, { label: 'access token 到期' }, formatTime(credential.expires))
            : null,
          React.createElement(
            Row,
            { label: 'Codex CLI 登录' },
            cli.present
              ? cli.bridgeable
                ? `可复用${cli.planType ? ` · 套餐 ${cli.planType}` : ''}`
                : `不可复用（${cli.bridgeError ?? cli.error ?? '未知原因'}）`
              : '未找到',
          ),
          cli.present ? React.createElement(Row, { label: '登录文件' }, cli.path) : null,
          React.createElement(
            Row,
            { label: 'openai-codex route' },
            route.configured
              ? React.createElement('span', { style: styles.badge('on') }, '已启用')
              : React.createElement('span', { style: styles.badge('off') }, '未启用'),
          ),
          route.configured
            ? React.createElement(
                Row,
                { label: '流式工具调用修复' },
                route.retriesMalformed === true
                  ? '按 id 纠正并行调用位置；参数解析失败时重试'
                  : React.createElement(
                      'span',
                      null,
                      React.createElement('span', { style: styles.badge('off') }, '部分启用'),
                      ' route 里没有 MALFORMED_RESPONSE 重试；点「补上重试」写入',
                    ),
              )
            : null,
          React.createElement(
            Row,
            { label: '模型列表' },
            React.createElement(
              'span',
              null,
              modelSource,
              ` · ${lastCheck}`,
              `（client_version ${models.clientVersion ?? '—'}）`,
            ),
          ),
          React.createElement(Row, { label: '模型自动更新' }, autoRefresh),
          React.createElement(
            Row,
            { label: '浏览器 OAuth' },
            status.flowAvailable ? '已注册，可在此发起' : '未注册（确认 llm-pi-ai 已加载）',
          ),
          React.createElement(
            'div',
            { style: styles.buttons },
            React.createElement(
              'button',
              {
                type: 'button',
                style: cli.bridgeable ? styles.primary : styles.button,
                disabled: busy !== '' || cli.bridgeable !== true,
                onClick: bridge,
                title: cli.bridgeable ? '把 Codex CLI 已有的 ChatGPT 登录写进 Harness 凭据库' : '没有可复用的 Codex CLI 登录',
              },
              busy === 'bridge' ? '写入中…' : '复用 Codex CLI 登录',
            ),
            React.createElement(
              'button',
              { type: 'button', style: styles.button, disabled: busy !== '' || status.flowAvailable !== true, onClick: startOauth },
              busy === 'oauth' ? '发起中…' : '浏览器登录',
            ),
            route.configured
              ? null
              : React.createElement(
                  'button',
                  { type: 'button', style: styles.button, disabled: busy !== '', onClick: enableRoute },
                  busy === 'route' ? '启用中…' : '仅启用 route',
                ),
            route.configured && route.retriesMalformed !== true
              ? React.createElement(
                  'button',
                  { type: 'button', style: styles.button, disabled: busy !== '', onClick: enableRoute },
                  busy === 'route' ? '写入中…' : '补上重试',
                )
              : null,
            credential.configured
              ? React.createElement(
                  'button',
                  {
                    type: 'button',
                    style: styles.button,
                    disabled: busy !== '',
                    onClick: refreshModels,
                    title: '向 Codex 查询当前可用的模型并写入 route；自定义或继承的 route 配置不会被覆盖',
                  },
                  busy === 'models' ? '拉取中…' : '更新模型列表',
                )
              : null,
            credential.configured
              ? React.createElement(
                  'button',
                  { type: 'button', style: styles.button, disabled: busy !== '', onClick: () => verify(false) },
                  busy === 'verify' ? '验证中…' : '验证能否用',
                )
              : null,
            credential.configured
              ? React.createElement(
                  'button',
                  { type: 'button', style: styles.button, disabled: busy !== '', onClick: () => verify(true) },
                  busy === 'refresh' ? '刷新中…' : '刷新 token',
                )
              : null,
            credential.configured
              ? React.createElement(
                  'button',
                  { type: 'button', style: styles.danger, disabled: busy !== '', onClick: signOut },
                  busy === 'signout' ? '删除中…' : '登出（删除本机凭据）',
                )
              : null,
          ),
          probe === undefined
            ? null
            : React.createElement(
                Row,
                { label: '真实请求验证' },
                React.createElement(
                  'span',
                  { style: probe.ok === true ? styles.ok : styles.error },
                  `${probe.ok === true ? '通过' : '失败'} —— ${probe.detail}`,
                ),
              ),
          error === '' ? null : React.createElement('p', { role: 'alert', style: styles.error }, error),
          message === '' ? null : React.createElement('p', { role: 'status', style: messageTone === 'neutral' ? styles.hint : styles.ok }, message),
        ),

        // ---------------------------------------------------------- API key ---
        //
        // A separate card because it is a separate route with a separate billing
        // model. Mixing it into the subscription card would read as "two ways to
        // do the same thing", which is the one thing this is not.
        React.createElement(
          'div',
          { style: styles.card },
          React.createElement('h2', { style: styles.title }, 'OpenAI API key（按量计费）'),
          React.createElement(
            'p',
            { style: { ...styles.hint, marginTop: 0 } },
            '填一个 Platform API key（',
            React.createElement('code', null, 'sk-…'),
            '），就会启用 llm-pi-ai 的 ',
            React.createElement('code', null, 'openai'),
            ' 这条 route，走 api.openai.com。它和上面的订阅登录互不影响，可以同时存在。',
          ),
          React.createElement(
            Row,
            { label: 'API key' },
            key.configured
              ? React.createElement(
                  'span',
                  null,
                  React.createElement('span', { style: styles.badge('on') }, '已保存'),
                  key.family === 'project'
                    ? ' project key（项目级）'
                    : key.family === 'user'
                      ? ' user key（用户级）'
                      : '',
                  key.source ? ` · 来源 ${key.source}` : '',
                )
              : React.createElement('span', { style: styles.badge('off') }, '未保存'),
          ),
          React.createElement(Row, { label: '凭据 reference' }, key.ref ?? 'OPENAI_API_KEY'),
          React.createElement(
            Row,
            { label: 'openai route' },
            key.enabled === false
              ? '已在此插件配置里关闭'
              : key.route?.configured
                ? React.createElement(
                    'span',
                    null,
                    React.createElement('span', { style: styles.badge('on') }, '已启用'),
                    key.route.apiKeyEnv ? ` · 绑定 ${key.route.apiKeyEnv}` : ' · 未绑定 apiKeyEnv',
                  )
                : React.createElement('span', { style: styles.badge('off') }, '未启用'),
          ),
          key.route?.baseURL && key.route.catalogDestination !== true
            ? React.createElement(Row, { label: 'route 指向' }, key.route.baseURL)
            : null,
          // A route that points somewhere else, or binds another reference, is a
          // route this plugin must not write a key for: say so instead of offering
          // a button that would either be refused or send a secret to the wrong
          // destination.
          key.bindingMismatch === 'destination'
            ? React.createElement(
                'p',
                { style: styles.hint },
                '这条 openai route 指向自定义端点，不是 api.openai.com；它的 key 属于那个端点，本插件不会拿自己的 reference 去验证或改写它。要在这台机器上验证自己的 key，请先在「设置 → 模型」里把这条 route 指回默认端点。',
              )
            : null,
          key.bindingMismatch === 'reference'
            ? React.createElement(
                'p',
                { style: styles.hint },
                `这条 openai route 绑定的是 ${key.route?.apiKeyEnv ?? '另一个 reference'}，不是本插件的 ${key.configuredRef ?? 'OPENAI_API_KEY'}；写入和验证都以 route 的绑定方为准，本插件不插手。`,
              )
            : null,
          React.createElement(
            'p',
            { style: styles.hint },
            'API key 由「设置 → 模型」里 ',
            React.createElement('code', null, 'openai'),
            ' 那一行的凭据输入框写入：那里是这套应用唯一经过授权的凭据写入口，写进去的就是 ',
            React.createElement('code', null, 'OPENAI_API_KEY'),
            ' 这个 reference，本插件不会另存一份，也不提供第二条写入路径。',
          ),
          React.createElement(
            'div',
            { style: styles.buttons },
            key.route?.configured
              ? null
              : React.createElement(
                  'button',
                  { type: 'button', style: styles.button, disabled: busy !== '' || key.enabled === false, onClick: enableApiKeyRoute },
                  busy === 'key-route' ? '启用中…' : '仅启用 route',
                ),
            key.configured && key.bindingMismatch === undefined
              ? React.createElement(
                  'button',
                  { type: 'button', style: styles.button, disabled: busy !== '', onClick: verifyApiKey },
                  busy === 'verify-key' ? '验证中…' : '验证 key',
                )
              : null,
          ),
          apiKeyProbe === undefined
            ? null
            : React.createElement(
                Row,
                { label: 'key 验证' },
                React.createElement(
                  'span',
                  { style: apiKeyProbe.ok === true ? styles.ok : styles.error },
                  `${apiKeyProbe.ok === true ? '通过' : '失败'} —— ${apiKeyProbe.detail}`,
                ),
              ),
          React.createElement(
            'p',
            { style: styles.hint },
            '验证是对 ',
            React.createElement('code', null, 'api.openai.com/v1/models'),
            ' 发一次不花 token 的请求，只说明这把 key 能否列出模型——能列模型不等于能推理，也不等于能计费。route 指向自定义端点、或绑定了别的 reference 时，插件不会发这次请求，以免把 key 交给它没被签发的地方。',
          ),
        ),

        attemptPhase === 'idle'
          ? null
          : React.createElement(
              'div',
              { style: styles.card },
              React.createElement('h2', { style: styles.title }, '浏览器登录进度'),
              React.createElement(Row, { label: '阶段' }, attemptPhase),
              attempt?.message ? React.createElement(Row, { label: '提示' }, attempt.message) : null,
              attempt?.url
                ? React.createElement(
                    Row,
                    { label: '打开' },
                    React.createElement('a', { href: attempt.url, target: '_blank', rel: 'noreferrer', style: { color: 'var(--dsw-alias-brand-primary)' } }, attempt.url),
                  )
                : null,
              attempt?.code ? React.createElement(Row, { label: '验证码' }, attempt.code) : null,
              question
                ? React.createElement(
                    'div',
                    null,
                    React.createElement(Row, { label: '需要你回答' }, question.message),
                    question.options && question.options.length > 0
                      ? React.createElement(
                          'div',
                          { style: { ...styles.buttons, marginTop: 8 } },
                          ...question.options.map((option) =>
                            React.createElement(
                              'button',
                              {
                                key: option.id,
                                type: 'button',
                                style: styles.button,
                                disabled: busy !== '',
                                onClick: () => run('answer', async () => {
                                  await call('/oauth/answer', { method: 'POST', body: { value: option.id } });
                                  return '已提交。';
                                }),
                              },
                              option.label ?? option.id,
                            ),
                          ),
                        )
                      : React.createElement(
                          'div',
                          null,
                          React.createElement('input', {
                            style: styles.input,
                            value: answer,
                            placeholder: question.placeholder ?? '粘贴授权码或重定向 URL',
                            onChange: (event) => setAnswer(event.target.value),
                          }),
                          React.createElement(
                            'div',
                            { style: styles.buttons },
                            React.createElement(
                              'button',
                              { type: 'button', style: styles.primary, disabled: busy !== '', onClick: submitAnswer },
                              busy === 'answer' ? '提交中…' : '提交',
                            ),
                          ),
                        ),
                  )
                : null,
              attempt?.error ? React.createElement('p', { style: styles.error }, attempt.error) : null,
              React.createElement(
                'div',
                { style: styles.buttons },
                React.createElement(
                  'button',
                  { type: 'button', style: styles.danger, disabled: busy !== '', onClick: cancelOauth },
                  '取消登录',
                ),
              ),
            ),

        React.createElement(
          'p',
          { style: styles.hint },
          '「复用 Codex CLI 登录」直接读取 ',
          React.createElement('code', null, '~/.codex/auth.json'),
          ' 里已有的 ChatGPT token，写进 Harness 自己的凭据库（',
          React.createElement('code', null, 'llm-pi-ai/openai-codex'),
          '），不联网、不重开浏览器。「浏览器登录」走内置的 pi-ai OAuth 流程：回调地址是 localhost:1455，被占用时改用粘贴授权码。',
        ),
      );
    }

    /**
     * The Models-page inline card.
     *
     * `settings.models.provider-card` is dispatched inside every card that shows
     * a pi-ai directory row, with `entryKey = settingsNs` — so this registration
     * only ever renders on the `llm-pi-ai` family, which owns both routes this
     * plugin enables. The row exists in the directory even before the route is
     * configured (the directory is catalog ∪ configured), which is what lets the
     * button appear on the very card where a user would look for it.
     *
     * Two rows matter here and they are not the same row: `openai-codex` is the
     * subscription route, `openai` is the API-key route. Each gets its own
     * one-line explanation and its own action, because the fix for "nothing is
     * configured" differs completely between them.
     *
     * Owner props: `{ provider: ProviderDirectoryEntry, configured: boolean,
     * keyConfigured: boolean }`.
     */
    function ModelsCard(props) {
      const providerId = props?.provider?.provider;
      const isCodex = providerId === 'openai-codex';
      const isApiKey = providerId === 'openai';
      const [status, setStatus] = React.useState(undefined);
      const [busy, setBusy] = React.useState('');
      const [note, setNote] = React.useState('');

      const refresh = React.useCallback(async () => {
        if (!isCodex && !isApiKey) return;
        try {
          setStatus(await call('/status'));
        } catch {
          setStatus(undefined);
        }
      }, [isCodex, isApiKey]);

      React.useEffect(() => {
        void refresh();
      }, [refresh]);

      if (!isCodex && !isApiKey) return null;

      const bridge = async () => {
        setBusy('bridge');
        setNote('');
        try {
          const result = await call('/sign-in', { method: 'POST', body: { mode: 'codex-cli' } });
          setNote(`已复用 ChatGPT 登录${result.planType ? `（${result.planType}）` : ''}，route ${result.route?.changed ? '已启用' : '已存在'}。`);
          await refresh();
        } catch (failure) {
          setNote(failure.message);
        } finally {
          setBusy('');
        }
      };

      if (isApiKey) {
        const key = status?.apiKey ?? {};
        const destination = key.route?.catalogDestination === false
          ? `这条 route 指向 ${key.route?.baseURL ?? '自定义端点'}，不是 api.openai.com。`
          : '';
        return React.createElement(
          'div',
          { style: { marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1)' } },
          React.createElement(
            'p',
            { style: { margin: '0 0 8px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 } },
            key.configured
              ? `Platform API key 已保存（reference ${key.ref}）${key.family === 'project' ? '，project key' : key.family === 'user' ? '，user key' : ''}。`
              : '这条 provider 走 OpenAI Platform 的按量计费，需要一个 sk-… 形式的 API key。',
          ),
          React.createElement(
            'span',
            { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
            'key 由本行自己的凭据输入框写入（那是应用唯一授权的写入路径）。',
            destination,
          ),
          note === ''
            ? null
            : React.createElement(
                'p',
                { style: { margin: '8px 0 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                note,
              ),
        );
      }

      const cli = status?.codexCli;
      const credential = status?.credential ?? {};
      return React.createElement(
        'div',
        { style: { marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1)' } },
        React.createElement(
          'p',
          { style: { margin: '0 0 8px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 } },
          credential.configured
            ? `ChatGPT 订阅凭据已保存${credential.expired ? '（access token 已过期，下次请求自动刷新）' : ''}。`
            : cli?.bridgeable
              ? `检测到 Codex CLI 的 ChatGPT 登录${cli.planType ? `（套餐 ${cli.planType}）` : ''}，可直接复用。`
              : '这条 provider 只认 ChatGPT 订阅登录（OAuth），不读 API key；要用 key 请选同一目录下的 openai。',
        ),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          cli?.bridgeable && credential.configured !== true
            ? React.createElement(
                'button',
                { type: 'button', style: styles.primary, disabled: busy !== '', onClick: bridge },
                busy === 'bridge' ? '写入中…' : '复用 Codex CLI 登录',
              )
            : null,
          React.createElement(
            'span',
            { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', alignSelf: 'center' } },
            '浏览器登录与登出在「设置 → GPT 接入」里。',
          ),
        ),
        note === ''
          ? null
          : React.createElement(
              'p',
              { style: { margin: '8px 0 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
              note,
            ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // A full page in Settings, where the whole lifecycle lives.
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'gpt-codex',
              order: 60,
              label: () => 'GPT 接入',
            },
            GptSection,
          ),
        );
        // And the inline card on the provider's own Models-page row, so the
        // sign-in button sits where a user looks for provider setup.
        //
        // The key must be the `entryKey` the owner dispatches with, which is
        // `row.entry.settingsNs` — `"llm-pi-ai"` for this adapter family. A keyed
        // slot resolves by `options.key === entryKey` (renderer client.js:1179),
        // so any other spelling renders nothing at all.
        ctx.slots.inject('settings.models.provider-card', () =>
          ctx.slots.register(
            {
              name: 'settings.models.provider-card',
              key: 'llm-pi-ai',
            },
            ModelsCard,
          ),
        );
      },
    };
  },
});
