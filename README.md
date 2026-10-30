# dsh-magpie-model

> English docs: [README.en.md](README.en.md).

把 [magpie](https://usemagpie.ai) 的本地网关接进 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 的模型选择器。

magpie 把各家 agent 的技能收在一处；这个插件把它的本地网关变成一个 dsh provider 路由：插件自己拉起并守护 `magpie serve` 进程，替纯 Go 的 magpie 补上 Android 缺失的本地 DNS 解析，从网关同步模型清单（含思考档位与上下文窗口），并以 dsh-llm 的 adapter 契约把 OpenAI 兼容流翻译成 harness 事件。

**不需要在 dsh 里填任何 API Key** —— 凭据由 magpie 自己的账号渠道持有。这个插件只驱动 magpie 的网关，从不接触 key。

## 为什么需要它（而不是直接用 magpie）

magpie 自带 handover：它检测到宿主 agent（它把 dsh 记为 PenguinHarness）后，会把自己作为一个名为 `magpie` 的 provider 写进 dsh 的模型配置（走 `dsh-llm-pi-ai`）。这在桌面上没问题，但在**移动端 / 无终端**的场景里，magpie 的可执行文件、网关进程、DNS 解析都得有人替它管——这正是本插件做的事。同时本插件**主动关掉 handover**（`MAGPIE_NO_HANDOVER=1`）并使用独立的 provider 路由名 `magpie-model`，避免和 handover 注入的 `magpie` provider 抢同一个名字（后者会让 pi-ai 整个 fiber 失败、profile degraded——见下文「踩过的坑」）。

## 功能

- **网关自托管**：插件 spawn `magpie serve`，用 `magpie healthcheck` 探活，退出后按退避重启。若已有 magpie 在跑（用户自己的 `magpie web`、或上一次引擎的遗留进程），则**接管**它而不是再起一个。
- **本地 DNS 转发器**（Android 必需）：magpie 是纯 Go 二进制，读 `/etc/resolv.conf` 取 DNS，而 Android 上该文件不存在（`/etc` 指向只读的 `/system/etc`）。插件在本地 53 端口起一个 UDP 转发器，转发到公共 DNS。
- **模型目录同步**：从网关 `/v1/models` 拉取，映射成 dsh 的 modelInfo（上下文窗口、最大输出、思考档位、vision）。定时 + 按需刷新。
- **思考档位真实生效**：把 harness 的 `off` 映射成 wire 的 `none`，其余同名透传，通过 `reasoning_effort` 下发。实测 `off` → 0 reasoning tokens，`xhigh` → 数十 token。
- **自动故障切换**：模型在**还没输出任何内容**时遇到空响应/连接中断，自动换下一个可用模型重试，绝不重复输出；用户取消、4xx 拒绝不切换；结果如实标注实际服务的模型。
- **模型固定 / 隐藏 / 排序**：6+ 个模型里只留常用的，并钉到选择器顶部；纯本地，零成本。
- **倍率与价格**：每个模型显示 magpie 自己的**倍率**（`rate`）与实际单价（`$输入/$输出 每 M token`），免费模型标「免费」。数据取自 magpie 网页 API `/api/providers`（与它自己的渠道页一致），不是插件瞎算的。
- **毛玻璃设置页**：网关/DNS 状态、逐模型测速、用量看板（按模型 / 按日曲线）、开关即时生效（写后自动重启网关，无需重启引擎）。
- **默认值即用**：装好即启用 `serveWeb`，访问 `http://127.0.0.1:3430/?k=<key>` 登录更多 magpie 账号渠道。

## 安装

```sh
# 1) 安装 magpie 到持久位置（引擎目录会被引擎更新清空，务必装到 ~/.local/bin）
TERMUX_VERSION=1 MAGPIE_MIRROR=https://ghfast.top/ MAGPIE_BIN_DIR="$HOME/.local/bin" \
  sh -c "$(curl -fsSL https://usemagpie.ai/install.sh)"

# 2) 把本插件放进 dsh 的 profile
#    （本仓库是一个 dsh bundle 包：含 dsh.bundle.patch + dsh.client 半身）
```

`package.json` 里声明了 `dsh.bundle.patch`（host 半）与 `dsh.client`（浏览器半）。把仓库目录放进 profile 的 `node_modules`（或 `link:` 到别处），再在 `dsh.profile.bundles` 里加 `dsh-magpie-model` 即可。

## 配置

设置页可改的项：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭后隐藏全部模型并拒绝调用，网关也停 |
| `dns` | `true` | 本地 DNS 转发器开关 |
| `serveWeb` | `true` | 同进程提供 magpie 网页控制台 |
| `addr` | `''`（→ `127.0.0.1:3425`） | 网关地址；`MAGPIE_ADDR` 环境变量优先 |
| `webAddr` | `''`（→ `127.0.0.1:3430`） | 网页地址 |
| `webKey` | `magpie-dsh-local` | 网页密钥，magpie 要求 16+ 字符（`[A-Za-z0-9-._~]`） |
| `refreshMinutes` | `10` | 清单刷新间隔，0 = 不定时 |
| `autoFallback` | `true` | 模型在**还没输出内容**时遇到空响应/中断，自动换下一个模型重试（不重复输出；取消、4xx 不切换） |
| `fallbackChain` | `[]` | 显式回退顺序（模型 id）；空 = 其它所有非路由组模型，按目录顺序 |
| `visibleModels` | `[]` | 选择器里显示哪些模型及顺序；空 = 全部，非空 = 仅这些且按此顺序 |

bundle patch 里钉死的字段（`pinned`）在页面上会灰掉、不可编辑——patch 值只在本进程内存里覆盖，不写进持久设置文件。

## 开发与测试

```sh
node test/integration.mjs     # 16 项：mock 内核挂载、事件契约、真实网关往返、effort 生效、取消、DNS、API、路由撞车回归锁
node test/client-lint.mjs     # 浏览器半：在 stub 的 ModuleLoader 下真实执行 factory、渲染全部组件、中英 key 对齐
node test/verify-live.mjs     # 活体核验：token 握手 + 插件 status/models + profile 健康 + 一次真实往返
```

## 自检与自动修复：`doctor`

dsh Mobile 的 app 更新会重装引擎目录，但保留 `$DSH_HOME` 下的用户数据。本插件所需的一切（源码、magpie 二进制、账号、设置、profile 注册）都刻意放在 `$DSH_HOME`，所以更新通常不影响它。但有两种失败是**静默的**——插件直接不加载、模型选择器里没有 Magpie 分组，只有引擎日志里才看得出：

1. profile 的 `dsh.profile.bundles` 不再列出 `dsh-magpie-model`（大版本升级重写了模板）；
2. profile 的 `node_modules/dsh-magpie-model` symlink 丢失或悬空（node_modules 被重建、或离线安装失败）。

`doctor` 检查这两项（以及源码、二进制、账号、运行态），**就地修复**（改文件前先备份、幂等），再跑一次活体检查证明插件真的在服务：

```sh
node scripts/doctor.mjs            # 检查 + 修复 + 活体核验（含一次真实往返）
node scripts/doctor.mjs --check    # 只检查，不改任何文件
node scripts/doctor.mjs --no-live  # 跳过活体（纯本地，约 180ms，零成本）
node scripts/doctor.mjs --json     # 机器可读结果
```

> **app 更新后**跑一次 `node scripts/doctor.mjs` 即可。**平时每次**想确认就 `--no-live --check`（180ms、不联网、不推理、不花钱），足以抓住上面两类静默故障。

## 踩过的坑（都修了，也都留了回归锁）

这些是开发/上线过程中真实踩到并在本仓库里修掉的，记下来给后来者：

1. **provider 路由名撞车让整个 profile degraded**。最初路由名叫裸 `magpie`，与 magpie handover 注入 `dsh-llm-pi-ai` 的 provider 同名 → `LlmError: configurable provider "magpie" is already declared` → pi-ai 整个 fiber 失败、profile degraded，连带把默认模型打挂。修复：路由改名 `magpie-model` + `MAGPIE_NO_HANDOVER=1`。
2. **二进制装进引擎目录被更新抹掉**。`curl … | sh` 默认装到 `$PREFIX/bin`，而那是引擎托管目录，引擎更新会清空。修复：装到 `~/.local/bin`（引擎不碰 `$HOME`），`locateMagpie` 优先探这里。
3. **纯 Go 的 magpie 在 Android 上解析不了任何域名**。`/etc/resolv.conf` 不存在、Go 回退 `[::1]:53` 被拒。修复：本地 53 端口 DNS 转发器。
4. **bundle patch 的 config 被写进持久设置，污染用户配置**。挂载时带 `{enabled:false}` 的测试配置会被持久化，导致引擎下次启动插件就是关的。修复：patch 只做内存 overlay，并拒绝写 pinned 字段（409）。
5. **热重载泄漏 :53 监听**。fiber 在 bind 飞行中销毁会把监听器孤儿化。修复：post-await `disposed` 检查。
6. **思考模型在小 max_tokens 下答案被截断**。reasoning token 占用 `max_tokens` 预算。测试因此偶发失败；用 `effort off` 变确定性，顺带证明 effort 真实生效。
7. **用户取消必须报 `aborted` 而非可重试的 TRANSPORT**，否则内核会重跑用户主动停掉的轮次。

## 许可

MIT
