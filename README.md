# dsh-gpt-codex — 用 ChatGPT 订阅或 OpenAI API key 驱动 DeepSeek Harness 桌面版

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

这个插件把 GPT 接进桌面版，**两条独立的计费与鉴权路线各走各的**：

- **ChatGPT 订阅**（OAuth 登录，走 `chatgpt.com/backend-api`，用你的订阅额度）
- **OpenAI API key**（`sk-…`，走 `api.openai.com`，按量计费）

底层东西其实官方都已经装好了，本插件不重复实现：

| 已原生具备 | 位置 |
|---|---|
| pi-ai 适配器（dormant，零 route） | `@deepseek-ai/dsh-llm-pi-ai`，随 `dsh-base` 挂载 |
| `openai-codex` provider，`https://chatgpt.com/backend-api`，打包时写死的模型目录 | `@earendil-works/pi-ai` 1.3.0 |
| `openai` provider，`https://api.openai.com/v1`，40+ 个 chat 模型，自带 apiKey 鉴权 | 同上 |
| ChatGPT OAuth 授权流（`llm-pi-ai/openai-codex`） | `dsh-llm-pi-ai` 的 `registerPiAiFlows` |
| 凭据落盘与跨进程刷新 | `dsh-credentials-local` → `~/.dsh/.credentials.yaml` |

**缺的是这几件事**，也正是本插件补的东西（0.3.0 起多了第三件：把模型列表跟上游对齐）：

1. **没人能触发那条 OAuth 流。** 全应用里 `authorization.begin()` 的唯一调用方是 DeepSeek 账号插件；Models 页面对 `openai-codex`（`env: []` + `oauth: true` 的 keyless native auth）**连 API key 输入框都不渲染**，`settings.models.sign-in` 又被 DeepSeek 首次引导占着。所以界面上根本没有登录入口。
2. **`llm-pi-ai` 没有 `openai-codex` 这条 route**，即使有凭据也不服务任何模型。
3. **`llm-pi-ai` 也没有 `openai` 这条 route**，所以就算在 Models 页填了 `OPENAI_API_KEY`，也没有任何 provider 会去用它。

> 换句话说：官方并不缺 GPT 适配器，缺的是**触发登录的入口**和**两条 route**。这个插件只补这几处，不重写适配器。

## 快速开始

```bash
git clone https://github.com/bhjia-phys/dsh-gpt-codex.git
cd dsh-gpt-codex
npm test          # 离线回归：host 68 项、refresh 22 项、models 19 项、contract 9 项、JSON/代理/流式修复各一套，不访问外网、不碰真实凭据
```

安装到某个 DSH profile（以 `desktop` 为例）：

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dsh": { "profile": { "bundles": [ /* … */ "dsh-gpt-codex" ] } },
"dependencies": { "dsh-gpt-codex": "link:/absolute/path/to/dsh-gpt-codex" }
```

把包链接进 profile 的 `node_modules/`（非 scoped 包直接放顶层），重启桌面版，然后打开 **设置 → GPT 接入**。

## 三条接入方式

### A. 复用已有的 Codex CLI 登录（推荐，最快）

如果你在这台机器的 Codex CLI 里已经登录过 ChatGPT（`~/.codex/auth.json` 存在且 `auth_mode: chatgpt`），插件直接把里面的 OAuth token 搬进 Harness 的凭据库：

- **不联网、不重开浏览器、不重新授权**
- 写入的记录形状与 `dsh-llm-pi-ai` 读取的完全一致：`kind: grant` + `payload: { type:'oauth', access, refresh, expires, accountId }`
- `accountId` 从 access token 的 `https://api.openai.com/auth` claim 里读（就是 pi-ai 自己 `credentialsFromToken` 的做法）；`expires` 来自 JWT 的 `exp`
- access token 过期也没关系：pi-ai 会在下一次请求时用 `refresh` token 自动续期

### B. 浏览器 OAuth（没有 Codex CLI 登录时）

插件在 Host 半调用 `ctx.authorization.begin({ key: 'llm-pi-ai/openai-codex' })`，把 pi-ai 自己的流程跑起来：

1. 先问你选登录方式（browser / device code）
2. browser：回调地址 `127.0.0.1:1455/auth/callback`；端口被占用时退化成「粘贴授权码或重定向 URL」
3. device code：给出验证码与 `https://auth.openai.com/codex/device`

面板会实时显示 URL、验证码和待回答问题。**登录尝试不可跨页面刷新恢复**（授权 seam 不持久化 attempt），刷新页面就得重来。

### C. OpenAI Platform API key（不需要订阅）

key 在**「设置 → 模型」里 `openai` 那一行的凭据输入框**写入 —— 那是这套应用唯一经过授权的凭据写入口，写进去的就是 reference `OPENAI_API_KEY`。本插件**不另存一份，也不提供第二条写入路径**：它只负责声明 `llm-pi-ai` 的 `openai` route —— 那是一条**目录里本来就有、但没人声明**的 route：`api.openai.com/v1`、自带 `apiKey` 鉴权、40+ 个 chat 模型 —— 以及只读地报告这把 key 的状态。

为什么 key 不能塞进 `openai-codex` 那条 route？两条硬约束，都在 pi-ai 内部：

1. `openai-codex-responses` 必须先解出 `chatgpt-account-id` 再发请求，而它的 `extractAccountId(token)` 用 `token.split(".")` 拆 JWT。`sk-…` 不是 JWT，长度不等于 3 → 直接抛 `Failed to extract accountId from token`。
2. 那个后端是 `https://chatgpt.com/backend-api`，语义就是"订阅账号的代发端点"，不是 Platform 计费端点。

反过来，`openai` 那条 route 天生就区分两者：`pi-ai/dist/api/openai-responses.js` 的 `isChatGPTSignIn(model, apiKey)` 用 **`!apiKey.startsWith("sk-")`** 判断要不要走订阅语义 —— 即 `sk-` 开头就是标准 Platform 鉴权。所以这两条路线在 pi-ai 里本来就是分开设计的，插件只负责把它们各自接上。

面板：**设置 → GPT 接入 → OpenAI API key（按量计费）** 只做四件事：报告 key 的有无（family 与来源，**永不回显**）、报告 `openai` route 的绑定与指向、单独启用 route、以及发起一次 `GET /v1/models` 验证。验证的结论严格限定在「这把 key 能不能列模型」——**能列模型不等于能推理，也不等于能计费**。

两条安全护栏，都在发请求之前生效：

- route 指向**自定义 `baseURL`/`api`**（中转站、网关）：那把 key 是给那个端点签发的，插件**不会**把它发到 `api.openai.com`，只回报 `CUSTOM_DESTINATION`。
- route 绑定的是**另一个 reference**：那把 key 归它的配置所有者，插件不拿自己的 reference 去验证，只回报 `BINDING_MISMATCH`。

## 两个必须知道的实测事实

这两条都不是推理出来的，是 2026-11-02 在这台机器上量出来的，而且都会让人误判成「插件坏了」。

### 1. `exp` 没过期 ≠ token 还能用

存进去的 access token 距离 `exp` 还有 **6.85 天**，但 `api.openai.com/v1/me` 和 Codex 后端都返回 **401**——服务端提前吊销了它。同一个 refresh token 却能正常换出新 token。

所以「凭据已配置」和「真的能用」是两个不同的事实，只有**真实请求**或**刷新**才能区分。插件因此：

- 桥接时**先刷新再存**，不信任 `exp`
- 提供 `GET /gpt-codex/verify`：发一次真实小请求，401 时自动刷新并重试一次
- `gpt_status` 默认带验证；`verify: false` 时才只看本地状态（并明确标注「未验证」）

### 2. 直连不通，而这台机器上 DSH 拿不到系统代理

`auth.openai.com` 和 `chatgpt.com` 直连**超时**；走本机 Clash（`127.0.0.1:7897`）立即通。而 Windows 的**系统代理开关是关着的**（`ProxyEnable: 0`），所以没有进程自动继承代理。

更麻烦的是：Node 的全局 `fetch` **默认忽略** `HTTP(S)_PROXY`，除非进程启动时就设了 `NODE_USE_ENV_PROXY=1`——已经跑起来的桌面版无法补上这个变量。

所以插件自己解析代理，并在加载时调用 Node.js 24.14+ 的 `http.setGlobalProxyFromEnv()`，立即重建全局 `fetch` dispatcher；卸载时恢复旧 dispatcher 和 agents，不修改进程环境变量。本机回环请求绕过代理，已有 `NO_PROXY` 配置继续保留。仅在运行中设置 `NODE_USE_ENV_PROXY=1` 不会重建已初始化的 dispatcher，可能出现「日志显示已走代理，实际聊天仍然 fetch failed」。代理选择顺序是 `proxy` 配置 > `HTTPS_PROXY`/`HTTP_PROXY` > 直连。在 `cordis.patch.yml` 里写：

```yaml
- id: gpt-codex
  name: 'dsh-gpt-codex'
  config:
    proxy: 'http://127.0.0.1:7897'
```

> 这条也是「处理失败 / token has expired」真正的根因：请求根本没到 OpenAI，或带着被吊销的 token 到了。

## 面板在哪

两个入口：

1. **设置 → GPT 接入**（`settings.section`，`id: gpt-codex`）：完整生命周期。三张卡片 —— 订阅凭据（状态与到期时间、ChatGPT 账号、Codex CLI 登录是否可复用、route 是否启用、OAuth 流是否可用）、**OpenAI API key**（只读状态：已保存与否、reference、`openai` route 的绑定与指向；动作只有「仅启用 route」和「验证 key」），以及两个共同的动作区。订阅侧的按钮：复用 Codex CLI 登录 / 浏览器登录 / 仅启用 route / **验证能否用** / **刷新 token** / 登出。
2. **设置 → 模型** 里那一行的卡片内（`settings.models.provider-card`）：`openai-codex` 行给「复用 Codex CLI 登录」按钮；`openai` 行说明这条 provider 要的是 API key，**并指向本行自己的凭据输入框 —— key 就在那里写，这是应用唯一授权的写入口**。

> 第 2 个入口有个坑值得记下来：`settings.models.provider-card` 是 **keyed** slot，渲染器按 `options.key === entryKey` 解析（`dsh-client-ui-renderer/lib/client.js:1179`），而 Models 页传入的 `entryKey` 是 `row.entry.settingsNs` —— pi-ai 家族即 `"llm-pi-ai"`。key 写成别的值不会报错，只是**静默不渲染**。测试里专门钉了这条契约。

## Agent 工具

模型自己也能操作这些事：

| 工具 | 作用 |
|---|---|
| `gpt_status` | 两条路线的完整状态：凭据、Codex CLI 可复用性、两条 route、模型列表维护状态；默认发一次真实请求确认订阅可用（`verify: false` 可跳过），同时报 API key 的有无与 `openai` route 的绑定/指向 |
| `gpt_sign_in` | `mode: 'codex-cli'`（默认）桥接；`mode: 'browser'` 会如实拒绝，因为需要人工交互 |
| `gpt_sign_out` | 删除本机记录（不向 OpenAI 撤销，也不动 Codex CLI 自己的登录） |
| `gpt_models` | 向 Codex 查这个账号能用的模型，写进 route（见「模型列表为什么不会自己更新」） |

**没有** `gpt_set_api_key` / `gpt_clear_api_key`，这是刻意的：一个接收原始 `sk-…` 的工具，会把 key 写进助手自己的消息里（工具还没执行就已经记下了），事后从返回值里抹掉保护不了任何东西；一个 `unset` 共享 reference 的工具，也可能删掉别的 route 正依赖的凭据。凭据的写入与删除归「设置 → 模型」，插件只读不写。

工具直接返回纯 JSON：未知的 `planType`、`authMode`、凭据字段及不存在的 `bridgeError` 会被结构化省略，而不是返回 `undefined`；`verify: false` 不含 `probe`。时间戳只输出有限数值；异常 JWT/刷新响应的到期值沿用缺少到期值时的当前时间回退，已存记录中的非有限到期值不输出。工具边界不靠 `JSON.stringify` 静默清理非法值。

## HTTP 路由

客户端半只能走同源 `fetch`（client bundle 里没有 `host`、没有 fs、没有 `ctx.remote` 的自定义命名空间）：

```
GET  /gpt-codex/status
GET  /gpt-codex/stream-repair          # 修复安装了哪些端点、改写过多少条事件
GET  /gpt-codex/models                 # route 现在供哪些模型、列表归谁维护
POST /gpt-codex/models/refresh         # 向 Codex 重拉模型列表并写入 route
POST /gpt-codex/sign-in        { mode: 'codex-cli' }
POST /gpt-codex/sign-out
POST /gpt-codex/oauth/start
POST /gpt-codex/oauth/answer   { value }
POST /gpt-codex/oauth/cancel
GET  /gpt-codex/oauth/state
POST /gpt-codex/route/enable

GET  /gpt-codex/api-key/status
GET  /gpt-codex/api-key/verify       # 只读：问目标端点这把 key 能否列模型
POST /gpt-codex/api-key/route        # 只启用 route，不碰凭据
```

> **没有** `POST`/`DELETE /gpt-codex/api-key`。凭据的写入与删除只走「设置 → 模型」的授权 UI；本插件在 `/api-key` 上开一个写入口，等于给同一份共享 reference 造出第二个所有者，还会绕开那套 UI 的鉴权。

## 模型列表为什么不会自己更新（以及 0.3.0 怎么修）

**症状**：GPT 明明发布了新模型，选择器里没有；已经下线的模型却还在，选中就报
`model_not_found`。2026-11-17 实测：已安装的 pi-ai 1.3.0 目录里有 9 个模型，其中
`gpt-5.3-codex-spark` 和 `gpt-5.5` 后端已经拒绝（`not supported when using Codex with a
ChatGPT account`），而当时正在服务的 `gpt-6.2-sol`、`gpt-6.2-astra`、`gpt-6.1-terra`
一个都不在目录里。

**为什么不会自己更新**，三处原因叠在一起，缺一不可：

1. 模型目录是**打包进应用的一个 JSON 文件**（`pi-ai/dist/providers/data/openai-codex.json`），
   内容在构建那一刻就定了。app.asar 里的文件不会因为服务端上新而改变。
2. pi-ai 的 `openai-codex` provider 没有 `fetchModels`，而 `dsh-llm-pi-ai` 的
   `buildProvider` / `reuseCatalogProvider` 明确**丢掉**了 catalog 自带的动态刷新
   （注释写得很直白：*this route's catalog is the settings document*）。
   `discovery.ts` 的 `LISTABLE_PROTOCOLS` 也故意排除了 Codex 这条协议——它走 OAuth，
   一个天真的 `GET /models` 会把鉴权失败读成「没有模型」。
3. 插件的 route 只写了 `transport: 'sse'`，不写 `models`，于是**继承**上面那个静态目录。
   没有任何东西在盯着上游发布。

**权威来源是有的**，Codex CLI 自己就用它：

```
GET https://chatgpt.com/backend-api/codex/models?client_version=<x.y.z>
Authorization: Bearer <ChatGPT access token>
ChatGPT-Account-ID: <account id>
```

`client_version` **必填**（不带直接 400），而且它会**过滤结果**：旧版本看到更少的模型
（实测 0.150.0 → 5 个，0.160.0 → 10 个，0.169.0 → 12 个）。返回里每条带
`slug`、`display_name`、`context_window`、`input_modalities`、
`supported_reasoning_levels`、`visibility`（`list` / `hide`）。

**0.3.0 的做法**（`models.js` + route 的 `models` 字段）：

- 插件向上面这个接口要列表，只取 `visibility: "list"` 的行（`gpt-reserve`、
  `codex-auto-review` 是内部路由的隐藏行，不该出现在选择器里），映射成 route 的
  `models` 条目：`name` / `contextWindow` / `input`（`audio` 丢掉，harness 没有这个模态）/
  `reasoningEfforts`。
- 服务端列的 `ultra` 档位 pi-ai 没有对应名字（最高是 `max`），**丢掉而不是硬塞给
  `max`**——否则选择器会给出一个请求时必然失败的档位。
- `reasoningEfforts` **刻意不写 `off`**。实测这条链只在一种写法下能跑通：profile 省略
  `off` → 解析器把它钉成 `null` → pi-ai 的 Codex 构造器看到 `map.off === null` 就
  不发 reasoning 块。若写成 `off: 'none'` 或让 `off` 出现在 map 里，pi-ai 会发
  `{"effort":"none"}`，而 `gpt-6.x` 直接回 400
  （`Unsupported value: 'none' is not supported with the 'gpt-6.2-sol' model`）。
- 写进去的 route 额外带一个 `modelsDigest`（内容指纹）。**只有指纹对得上的列表才会被
  覆盖**：手写/改过的 `models`（钉版本、只留几个、改过某个字段）永远不动，插件只在
  `gpt_status` / `gpt_models` 里报告「服务端多了什么、少了什么」。
- 自动更新：启动时检查缓存；过期时拉取，**Host 持续运行期间也会定时检查**，默认每
  `modelsRefreshHours: 24` 小时一次，无需重启。用 `$DSH_HOME/gpt-codex-models.json`
  记上次成功查询的时间，缓存还新时等到到期再查；失败保留旧列表，间隔后重试。
  手动和自动查询共享一次进行中的请求；卸载会清理定时器并取消未完成的网络请求。
  关掉定时查询用 `autoRefreshModels: false`，禁用模型同步用 `manageModels: false`
  （保留已有列表，不会自动删掉已写的 `models`）。
- 配置保护：归属判断看 settings 的原始 `user`，不拿带 schema 默认值的 `value` 来比较。
  有继承的 provider、手写 transport/retry/headers，或条目内新增的 `maxTokens` / `compat`
  都不覆盖；网络请求期间的编辑、revision 冲突也会重新检查。查询期间登出、切换账号或
  凭据改变，会丢弃旧账号的结果；401 刷新只原子替换仍是原来的授权记录，不会复活已登出的账号。
- 手动更新：面板「更新模型列表」按钮、`POST /gpt-codex/models/refresh`、`gpt_models` 工具。
- 服务端返回空列表时**拒绝写入**——写一个空 `models` 等于把整条 route 的目录删掉。

**为什么不用 `modelOverrides`**：它只能修改**已安装目录里已存在**的 id，对
`gpt-6.2-sol` 直接报错（`modelOverrides names "gpt-6.2-sol", which the installed catalog
does not describe`）。要走这条路就得先改 pi-ai 的目录文件，而它在 app.asar 里。

**为什么不改成把 pi-ai 升到 1.5.2**：1.5.2（2026-11-10）的目录里有 8 个模型，含
`gpt-6.1-terra` 但**没有** `gpt-6.2-*`；`gpt-6.2-astra/sol` 只在 pi-ai 的 git `main` 上
（CHANGELOG 还挂在 Unreleased）。升依赖只能追到上一代，而且下次上新还得再升一次——
这正是这次要解决的问题本身。

## 为什么 route 走 settings 而不是 bundle patch

Cordis patch 对匹配到的条目是**整段替换**、不深合并（`dsh-app-boot/README.md:204`），而 profile 的 `cordis.patch.yml` 已经写了 `llm-pi-ai` 的 providers。如果插件在 bundle 层 patch 这一行，会在 profile 层被整个覆盖掉。所以插件改用 `ctx.settings.mutate()` —— 与 Models 页同一条写入路径，落在真正生效的那一层。

`{ transport: 'sse' }` 这个 route 不是占位符，而是刻意的配置：

- 不写 `models` → `resolveRouteModels` 回落内置目录的 9 个模型
- 不写 `apiKeyEnv` → 走 pi-ai 自己的 OAuth credential store（即 `llm-pi-ai/openai-codex`）
- **不要**手写 `api: openai-codex-responses`：`supportedProtocols()` 只允许 openai-completions / openai-responses / anthropic-messages；catalog route 不写 `api` 才会复用 codex 实现
- **`transport: 'sse'` 是规避一个官方缺陷**：pi-ai 的 Codex WebSocket 缓存把 socket 连同 idle timer 留在模块级 Map 里，而这个版本里 `cleanupSessionResources` **零调用方**——没人调 `closeOpenAICodexWebSocketSessions`。结果是 WebSocket 那一轮答完之后事件循环不空，桌面版上表现为「回答完了但请求不收尾」。`auto` 可能选中 WebSocket，因此继承这个问题。上游 AITP fork 撞到同一件事，最后也把 SSE 定成默认。这只是传输选择，协议本身没变。
- 0.2.0 起 route 还带一条 `retryPolicy`，见下一节。

如果你自己已经配置了 `openai-codex`（换 transport、钉模型列表、改 endpoint），插件**不会覆盖**：它会报 `already-configured-differently` 然后放着不动。唯一的例外是「只有 `transport: 'sse'`、别的字段一个都没有」——那是 0.1.0 自己写的形状，会被就地补成当前的 route（`reason: 'upgraded'`）。

## 并行工具调用被合并：`Unexpected non-whitespace character after JSON`

**症状**（2026-11-12 在另一台机器上复现）：一轮里连着发两个 `grep`，整轮直接失败，面板上显示

```
本轮运行失败  Tool call "grep": Unexpected non-whitespace character after JSON at position 186
(line 1 column 187) Received arguments: {"pattern": "apiKeyEnv|openai-api-key|API key|nativeAuth", ...}{"pattern": "supportedProtocols|apiKeyEnv|...", ...}
MALFORMED_RESPONSE
```

`position 186` 正好是**第一条**调用的参数串长度（`'{"pattern": "apiKeyEnv|…README.md"}'` 就是 186 个字符）。也就是说两条调用的参数被拼进了同一个缓冲区。

**根因不在插件，在 pi-ai 1.3.0 的两处定位逻辑**：

- Responses 路径按 `output_index` 建槽（`openai-responses-shared.js` 的 `outputSlots` / `getSlot`），
- chat-completions 路径按 `tool_calls[].index` 建块（`openai-completions.js` 的 `toolCallBlocksByIndex`）。

两者都只用**位置**、不用 `item_id` / `id`。网关只要把两个并行调用放进同一个 `output_index`，两条参数文本就累加进同一块，最后按一个 JSON 解析 → 在第一条末尾的位置报 `Unexpected non-whitespace character`。适配器把它变成 `MALFORMED_RESPONSE`（`dsh-llm-pi-ai/src/stream.ts:210-231`），而这个码**不在默认重试集里**（`dsh-llm` 默认只重试 EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT），所以本轮第一次尝试就结束——「失败之后就不动了」正是这么来的。

**修法（0.2.0）**分两层：

1. `stream-repair.js` 在 fetch 层把 SSE 帧里的 `output_index` / `tool_calls[].index` 按 **id** 重新分配：**服务器宣告过的** 调用落到同一个位置时换一个空位，同一 id 的后继分片跟着它走。请求体、凭据、其他 URL 一律不碰；只有真的改写了位置字段的帧才重新编码，其余字节原样透传。
2. route 的 `retryPolicy` 把 `MALFORMED_RESPONSE` 加进重试码（`maxRetries: 2`）。这一层兜住切不开的坏数据，也兜住下面那条刻意不修的情形。

`GET /gpt-codex/stream-repair` 会报出装了哪些端点、改写过多少条事件：

```json
{ "ok": true, "version": "0.2.0", "responses": 3, "repairedEvents": 1,
  "endpoints": [{ "url": "https://chatgpt.com/backend-api/codex/responses", "dialect": "responses" }] }
```

`repairedEvents > 0` 说明你的网关确实在复用位置；`responses > 0` 但一直是 0，说明这条链路是干净的。

**刻意不修、留给重试的情形**（都会如实失败，不会变成「静默少一个调用」）：

- 分片里**完全没有 id** —— 没有可归属的依据。
- 只有参数分片、服务器从没 `output_item.added` 宣告过这个调用 —— 把它挪到新位置，解析器那边没有对应的 block，这个调用会被静默丢掉。宁可让这一轮失败并让重试重问，也不要给出一个错的答复。参数串里确实含两个 JSON 对象（`{"a":1}{"a":2}`）同属这一类。

**换到中转站**（route 的 `baseURL` 不是 Codex 后端）时，端点要显式告诉插件，否则 fetch 层不会碰它：

```yaml
- id: gpt-codex
  name: 'dsh-gpt-codex'
  config:
    proxy: 'http://127.0.0.1:7897'
    endpoints:
      - https://relay.example.com/openai/v1/responses                        # Responses 协议
      - { url: 'https://relay.example.com/v1/chat/completions', dialect: completions }
    retryMalformedResponses: true   # 设 false 则 route 只留 transport
```

API key 那条 route 的 profile 只有两行，规则同样「已存在就不覆盖」：

```js
{ apiKeyEnv: 'OPENAI_API_KEY', transport: 'sse' }
```

- **`apiKeyEnv` 是必须的**：没有它，pi-ai 的 `resolveProviderAuth` 根本不会去找 `api_key` 类型的存储凭据（`openai` 的 catalog auth 有 `apiKey`，但默认只从环境变量发现）。写上它之后，`dsh-llm-pi-ai` 的 `routeAuth()` 会给这条 catalog route 补一个 `harnessApiKeyAuth`，值从 Harness 凭据库按 reference 解析 —— key 因此**不经过插件内存里的任何持久结构**，与 Models 页写的是同一份。
- 不写 `api` / `baseURL` / `models` → 全部回落到内置目录（`api.openai.com/v1`、40+ 个模型、`openai-responses` 协议），插件不复制一份会漂移的模型表。
- 绑定到别的 reference 的既有 profile 也会被原样保留，只是面板会告诉你哪个 reference 正在生效，并**拒绝**用本插件的 reference 去验证它（`BINDING_MISMATCH`）。
- 带自定义 `baseURL`/`api` 的既有 profile 同样原样保留；指向非 `api.openai.com` 时，验证会直接回报 `CUSTOM_DESTINATION` 且**不发任何请求** —— 那把 key 归那个端点，不能拿去别处试。

## 安装

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dsh": { "profile": { "bundles": [ /* … */ "dsh-gpt-codex" ] } },
"dependencies": { "dsh-gpt-codex": "link:/absolute/path/to/dsh-gpt-codex" }
```

再把包链接进 profile 的 `node_modules/dsh-gpt-codex`（非 scoped 包放顶层），然后**重启桌面版**。

## 配置

```yaml
- insert:
    - id: gpt-codex
      name: 'dsh-gpt-codex'
      config:
        codexAuthPath: ''              # 空 = $CODEX_HOME 或 ~/.codex
        autoEnableRoute: true          # 已有 ChatGPT 凭据时自动补上 openai-codex route
        retryMalformedResponses: true  # route 的重试码加上 MALFORMED_RESPONSE
        endpoints: []                  # 中转站的流式端点（见上一节）
        manageModels: true             # 用服务端的模型列表维护 route 的 models
        autoRefreshModels: true        # 启动及持续运行中定时检查缓存，到期拉取
        modelsRefreshHours: 24
        modelsClientVersion: ''        # 空 = 用本机 Codex CLI 协商过的版本
        apiKeyEnv: 'OPENAI_API_KEY'    # key 存在哪个 reference（也是 Models 页写的那个名字）
        enableApiKeyRoute: true        # 有 key 时自动补上 openai route；false 则本插件完全不碰它
```

`apiKeyEnv` 里的名字必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`（凭据 seam 的语法），写错会在加载时直接抛错，而不是等第一次请求失败。

## 测试

```bash
node test-host.mjs          # 67 项：桥接、route 启用/升级、模型列表同步与归属判定、OAuth 状态机、工具、路由、客户端包形态、刷新自愈、真实探测
                            #        + API key 只读状态、无写入口边界、验证的三种失败形态、route 绑定/指向护栏、启动自动启用
node test-refresh.mjs       # 22 项：真实形态 settings、继承/条目编辑保护、网络/revision/账号竞态、定时更新/错误重试/卸载取消/单飞（假时钟，不等待真实周期）
node test-models.mjs        # 19 项：服务端列表 → route 条目的映射（ultra/off/隐藏行/无窗口行）、指纹稳定性、diff、拉取的失败形态
node test-contract.mjs      #  9 项：record 能否通过真实 store 的准入规则；retryPolicy 是否被 schema 接受；两条 route 的 profile 与已安装目录交叉验证
node test-json.mjs          # 31 项：直接 execute/render 的 lossless JSON 边界；成功/失败、缺字段、异常时间戳
node test-proxy.mjs         # 本地代理回归：先初始化 fetch，再加载插件；检查代理生效、回环绕过与卸载恢复
node test-stream-repair.mjs # 16 项：用**已安装的 pi-ai** 重放「两个调用挤在一个 output_index」，直到 stream() 端到端
```

`test-stream-repair.mjs` 不是对着本仓库自己的假设打转：它从 `app.asar` 里解出真实的 `openai-responses-shared.js` 跑，先证明未修复时确实报出 `…after JSON at position 186`，再证明修复后两个调用都能解析。找不到应用时这一组跳过（可用 `DSH_ASAR` 指定路径）。

这些测试不访问外网、不发起真实 OAuth、不碰真实凭据库；代理回归只启动本机测试服务。其余测试用替身，未配置的 fetch 也被离线拦截；`test-contract.mjs` 会从已安装的 `app.asar` 里读出真实的 `openai-codex` / `openai` 目录与 `llm-pi-ai` 的 schema 做交叉验证。`test-json.mjs` 递归检查原始工具返回值和渲染块，拒绝 undefined、非有限数、负零、稀疏数组、循环及非普通对象，再核对 JSON 往返不丢信息，避免 HTTP 序列化先吞掉问题。

## 已知边界

- **订阅那条路必须有真实的 ChatGPT 账号。** 插件不绕过计费或授权。
- **`begin()` 只确认「本次 attempt 内 record 被提交」，不保证 token 可用。** 首次真实请求能否被 codex 后端接受，需要真实网络与订阅才能证明 —— 这不在本插件的测试范围内。
- **API key 那条路在本仓库里只做了离线单测。** 测试用的是替身凭据与假 `fetch`，没有真的打过 `api.openai.com`。真实端到端验证需要一把有效的 Platform key（`/v1/models` 本身不花 token）。
- **「验证通过」只覆盖列模型权限。** `GET /v1/models` 返回 2xx 只证明这把 key 能列模型；它不证明能推理、不证明项目有余额、也不证明计费可用。`429` 与「2xx 但响应不是 JSON」都按**失败**报，不会被读成通过。
- **面板里的浏览器登录依赖 Host 进程存活**；页面刷新会丢掉进行中的 attempt。
- **Codex CLI 那条路只有在 `auth_mode: chatgpt` 时可用**；`auth_mode: apikey` 会被明确拒绝（不会悄悄搬一个错误形状进去）。注意：那个拒绝是**对的** —— Codex CLI 里存的 `apikey` 是给 `openai-codex-responses` 用的，搬进来只会在第一次请求时炸在 `extractAccountId` 上。
- pi-ai 的 `originator` 头默认是 `"pi"`。若后端策略要求别的值，需要在 pi-ai 上游改，插件层碰不到。
- **流式修复只覆盖 SSE。** WebSocket 那一路不经过 `fetch`，位置复用问题在那里修不了；插件把 route 钉在 SSE 上，正是为了让它自己的修复有机会生效。
- **重试是「再花一次订阅额度」。** `retryMalformedResponses` 打开后，一次坏响应会重问最多 2 次；这是刻意的取舍，不是白拿。`gpt_models` 只发一次很小的 GET，不消耗生成额度。
- **模型列表 = 「这个账号现在能看到什么」。** 服务端按 `client_version` 过滤（旧版本看到更少的模型），所以 `modelsClientVersion` 留空时用的是本机 Codex CLI 协商过的版本；某台机器的 Codex 很旧时它看到的列表也会偏少，把它钉到一个已知够新的版本即可。
- **手写/编辑过的模型列表及继承的 provider 不会被覆盖。** 这是刻意的：宁可让 `gpt_models` 报告差异而列表不动，也不要悄悄改掉你自己钉的列表。若只是手写列表，删掉 `models` 后可重新查询；若还有自定义 route 字段或继承配置，必须先由配置所有者确认如何交回管理。

## 更多文档

- [docs/desktop-integration-findings.md](docs/desktop-integration-findings.md) — 桌面版链路核实：登录入口到底缺在哪、凭据怎么落盘、`interaction` 的精确类型，以及两条**实测出来**的坑（token `exp` 未到期却已被吊销；Node 的 `fetch` 默认忽略代理导致请求根本没发出）。
- [docs/aitp-agent-fork-inventory.md](docs/aitp-agent-fork-inventory.md) — 对照 AITP-agent fork：官方 0.2.1-rc.5 已原生具备什么、那个 fork 独有改了什么，以及**哪些问题只写插件根本修不了**（适配器 `dispose()`、错误分类、WebSocket 缓存所有权等）。
- [tools/extract-asar.mjs](tools/extract-asar.mjs) — 上面两份文档里每条结论都标了 `文件:行号`；这个工具从你自己安装的应用里重新解包，用来核对。不含任何厂商源码。

## 贡献

运行完整测试：

```bash
npm test
```

测试不访问外网、不碰真实凭据；代理回归要求 Node.js 24.14+。`test-contract.mjs` 会尝试从已安装的 DeepSeek Harness 里读真实目录做交叉验证；找不到应用时自动跳过（可用 `DSH_ASAR` 指定路径）。

## 许可

[MIT](LICENSE)
