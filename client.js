/**
 * Magpie Model — browser half.
 *
 * Contributes one thing to the web shell: a settings section (`settings.section`
 * id `magpie-model`) holding the gateway's state, the model roster it serves, the
 * usage dashboard, and the switches that control the supervised process.
 *
 * It shadows nothing. The stock model picker groups strictly by provider route,
 * and `magpie` is this plugin's route — so the models the host half registered
 * appear in the ordinary picker under their own heading with no client-side work
 * at all. That is the whole reason the host half registers a route rather than
 * patching a list.
 *
 * Data is read over the plugin's own same-origin `/api/magpie-model/*` routes
 * rather than a typed Remote binding, because those routes are served by the same
 * host process on every kernel line this plugin targets; a Remote binding would
 * need a declaration per kernel generation.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. All colour comes from theme variables so the
 * page survives a scheme switch, which is also what keeps the glass effect legible
 * in both light and dark.
 */
window.__ModuleLoader__.load({
  id: 'dsh-magpie-model',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useMemo, useRef, useCallback } = React

    const NS = 'settings.magpieModel'
    const API = '/api/magpie-model'
    const inject = ['slots', 'locale']

    // ── copy ──────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        'meta.title': 'Magpie Model',
        'meta.description': '把 magpie 的本地网关接进 dsh：插件自己拉起并守护 magpie serve，替纯 Go 的 magpie 补上 Android 缺失的 DNS 解析，从网关同步模型清单（含思考档位与上下文窗口）。无需填 API Key —— 凭据由 magpie 自己的账号渠道持有。',
        nav: 'Magpie',
        title: 'Magpie Model',
        pitch: 'magpie 把各家 agent 的模型收在一处；这个插件把它的本地网关接进 dsh 的模型选择器。插件自己启动并守护 magpie serve 进程，并替纯 Go 的 magpie 补上 Android 没有的本地 DNS 解析——否则它一个域名都解析不了，清单永远是空的。不需要在 dsh 里填任何 API Key：登录态由 magpie 自己的账号渠道持有。',

        'gateway.title': '网关',
        'gateway.state': '状态',
        'gateway.addr': '地址',
        'gateway.mode': '来源',
        'gateway.mode.adopted': '接管已有进程',
        'gateway.mode.spawned': '插件启动',
        'gateway.mode.none': '未运行',
        'gateway.pid': '进程号',
        'gateway.restarts': '重启次数',
        'gateway.magpie': 'magpie 版本',
        'gateway.page': '网页控制台',
        'gateway.openPage': '打开',
        'gateway.start': '启动网关',
        'gateway.stop': '停止网关',
        'gateway.restart': '重启网关',
        'gateway.missing': '没有找到 magpie 可执行文件。安装：',
        'gateway.installCmd': 'curl -fsSL https://usemagpie.ai/install.sh | sh',
        'state.ready': '就绪',
        'state.notReady': '未就绪',
        'state.off': '已停用',

        'dns.title': 'DNS 解析',
        'dns.why': 'magpie 是纯 Go 二进制，读 /etc/resolv.conf 取 DNS——而 Android 上这个文件不存在（/etc 指向只读的 /system/etc）。没有它，magpie 解析不了任何域名，模型清单永远是空的。插件在本地 53 端口起一个转发器，把查询转给公共 DNS。',
        'dns.listening': '监听',
        'dns.upstream': '上游',
        'dns.queries': '已转发查询',
        'dns.failed': '绑定失败',
        'dns.needRoot': '绑定 53 端口需要 root；引擎不是 root 时这里会失败。',

        'models.title': '模型',
        'models.count': '个模型',
        'models.refresh': '刷新清单',
        'models.empty': '网关没有列出任何模型。这通常意味着 magpie 里还没有登录任何账号渠道——打开网页控制台登录一个。',
        'models.test': '测试',
        'models.testing': '测试中…',
        'models.show': '显示',
        'models.ctxLabel': '上下文',
        'models.outLabel': '最大输出',
        'models.inLabel': '输入',
        'models.hide': '隐藏',
        'models.showing': '在选择器中显示',
        'models.curatedHint': '取消勾选即可隐藏；模型在选择器里按此列表从上到下的顺序排列。',
        'models.pinnedOrder': '已固定选择顺序',
        'models.col.id': '模型',
        'models.col.context': '上下文',
        'models.col.output': '最大输出',
        'models.col.input': '输入',
        'models.col.thinking': '思考档位',
        'models.col.owner': '渠道',
        'models.col.rate': '倍率 / 价格',
        'models.free': '免费',
        'models.rateBadge': '倍率',
        'models.perM': '/M',
        'models.group': '路由组',
        'models.vision': '图像',
        'models.textOnly': '文本',

        'usage.title': '用量',
        'usage.turns': '轮次',
        'usage.input': '输入 token',
        'usage.output': '输出 token',
        'usage.reasoning': '思考 token',
        'usage.cacheRead': '缓存读取',
        'usage.byModel': '按模型',
        'usage.recent': '最近',
        'usage.empty': '还没有用量记录。',

        'settings.title': '设置',
        'settings.enabled': '启用 Magpie 模型',
        'settings.enabledHint': '关闭后隐藏全部模型并拒绝所有调用；网关进程也会停下。',
        'settings.serveWeb': '同时提供 magpie 网页控制台',
        'settings.serveWebHint': '从同一个进程提供 magpie web 的页面，用于登录账号渠道。',
        'settings.dns': '运行本地 DNS 转发器',
        'settings.dnsHint': '关掉后 magpie 将解析不了任何域名，除非系统另有 DNS。',
        'settings.autoFallback': '自动故障切换',
        'settings.autoFallbackHint': '某模型在还没输出任何内容时遇到空响应或连接中断，自动换下一个可用模型重试（不会重复输出；取消和 4xx 不切换）。',
        'settings.addr': '网关地址',
        'settings.addrHint': '留空用 magpie 自己的默认（127.0.0.1:3425）。环境变量 MAGPIE_ADDR 优先于此。',
        'settings.webAddr': '网页地址',
        'settings.webKey': '网页密钥',
        'settings.webKeyHint': '固定密钥让同一个链接在重启后仍然有效；magpie 要求 16 个以上字符，取自字母、数字和 - . _ ~。留空则每次启动换新密钥。',
        'settings.refresh': '清单刷新间隔（分钟）',
        'settings.refreshHint': '0 表示不定时刷新。',
        'settings.save': '保存',
        'settings.saved': '已保存',
        'settings.applyHint': '保存后立即生效：启用开关、地址、网页选项会自动重启网关，无需重启引擎。',
        'settings.pinned': '这个字段由 bundle patch 固定，不能在这里修改。',
        'settings.pinnedTag': 'patch 固定',

        'log.title': '最近事件',
        'log.empty': '暂无事件。',

        loading: '正在加载…',
        loadFailed: '无法连接插件后端',
        retry: '重试',
        ok: '好',
        close: '关闭',
        cancel: '取消',
        error: '错误',
        unknown: '未知',
        never: '从未',
      },
      en: {
        'meta.title': 'Magpie Model',
        'meta.description': 'Brings magpie\'s local gateway into dsh: the plugin starts and supervises magpie serve, supplies the local DNS resolution a pure-Go magpie cannot get on Android, and syncs the gateway\'s model catalog (thinking levels and context windows included). No API key to enter — magpie\'s own account channels hold the credentials.',
        nav: 'Magpie',
        title: 'Magpie Model',
        pitch: 'magpie collects every agent\'s models in one place; this plugin brings its local gateway into dsh\'s model picker. The plugin starts and supervises the magpie serve process itself, and supplies the local DNS resolution a pure-Go magpie cannot get on Android — without it magpie resolves no hostname at all and its catalog stays empty. No API key is configured here: magpie\'s own account channels hold the sign-ins.',

        'gateway.title': 'Gateway',
        'gateway.state': 'State',
        'gateway.addr': 'Address',
        'gateway.mode': 'Source',
        'gateway.mode.adopted': 'adopted an existing process',
        'gateway.mode.spawned': 'started by the plugin',
        'gateway.mode.none': 'not running',
        'gateway.pid': 'PID',
        'gateway.restarts': 'Restarts',
        'gateway.magpie': 'magpie version',
        'gateway.page': 'Web console',
        'gateway.openPage': 'Open',
        'gateway.start': 'Start the gateway',
        'gateway.stop': 'Stop the gateway',
        'gateway.restart': 'Restart the gateway',
        'gateway.missing': 'No magpie executable was found. Install it with:',
        'gateway.installCmd': 'curl -fsSL https://usemagpie.ai/install.sh | sh',
        'state.ready': 'ready',
        'state.notReady': 'not ready',
        'state.off': 'switched off',

        'dns.title': 'DNS resolution',
        'dns.why': 'magpie is a pure-Go binary: it reads /etc/resolv.conf for its DNS, and on Android that file does not exist (/etc points at a read-only /system/etc). Without a resolver magpie looks up no hostname at all, so its model catalog stays empty. The plugin runs a forwarder on local port 53 that hands every query to a public resolver.',
        'dns.listening': 'Listening',
        'dns.upstream': 'Upstream',
        'dns.queries': 'Queries forwarded',
        'dns.failed': 'Bind failures',
        'dns.needRoot': 'Binding port 53 needs root; this fails when the engine is not root.',

        'models.title': 'Models',
        'models.count': 'models',
        'models.refresh': 'Refresh the catalog',
        'models.empty': 'The gateway lists no models. That usually means no account channel is signed in inside magpie yet — open the web console and sign one in.',
        'models.test': 'Test',
        'models.testing': 'Testing…',
        'models.show': 'Show',
        'models.ctxLabel': 'Context',
        'models.outLabel': 'Max output',
        'models.inLabel': 'Input',
        'models.hide': 'Hide',
        'models.showing': 'Shown in the picker',
        'models.curatedHint': 'Uncheck to hide; the picker orders models top-to-bottom by this list.',
        'models.pinnedOrder': 'Pinned order',
        'models.col.id': 'Model',
        'models.col.context': 'Context',
        'models.col.output': 'Max output',
        'models.col.input': 'Input',
        'models.col.thinking': 'Thinking levels',
        'models.col.owner': 'Channel',
        'models.col.rate': 'Multiplier / price',
        'models.free': 'Free',
        'models.rateBadge': 'Rate',
        'models.perM': '/M',
        'models.group': 'routing group',
        'models.vision': 'image',
        'models.textOnly': 'text',

        'usage.title': 'Usage',
        'usage.turns': 'Turns',
        'usage.input': 'Input tokens',
        'usage.output': 'Output tokens',
        'usage.reasoning': 'Reasoning tokens',
        'usage.cacheRead': 'Cache reads',
        'usage.byModel': 'By model',
        'usage.recent': 'Recent',
        'usage.empty': 'No usage recorded yet.',

        'settings.title': 'Settings',
        'settings.enabled': 'Enable Magpie models',
        'settings.enabledHint': 'Off hides every model and refuses every call; the gateway process stops too.',
        'settings.serveWeb': 'Also serve magpie\'s web console',
        'settings.serveWebHint': 'Serves magpie web\'s page from the same process, for signing account channels in.',
        'settings.dns': 'Run the local DNS forwarder',
        'settings.dnsHint': 'Off leaves magpie unable to resolve any hostname unless the system provides DNS another way.',
        'settings.autoFallback': 'Automatic failover',
        'settings.autoFallbackHint': 'If a model fails (empty response or dropped connection) before it emits any output, retry the turn on the next available model. Never duplicates output; cancellations and 4xx are not switched.',
        'settings.addr': 'Gateway address',
        'settings.addrHint': 'Empty uses magpie\'s own default (127.0.0.1:3425). The MAGPIE_ADDR environment variable outranks this.',
        'settings.webAddr': 'Page address',
        'settings.webKey': 'Page key',
        'settings.webKeyHint': 'A fixed key keeps one link valid across restarts; magpie wants 16+ characters from letters, digits and - . _ ~. Empty mints a fresh key per run.',
        'settings.refresh': 'Catalog refresh interval (minutes)',
        'settings.refreshHint': '0 means no periodic refresh.',
        'settings.save': 'Save',
        'settings.saved': 'Saved',
        'settings.applyHint': 'Takes effect on save: the enable switch, address and page options restart the gateway automatically — no engine restart needed.',
        'settings.pinned': 'A bundle patch pins this field, so it cannot be changed here.',
        'settings.pinnedTag': 'pinned by patch',

        'log.title': 'Recent events',
        'log.empty': 'No events yet.',

        loading: 'Loading…',
        loadFailed: 'Could not reach the plugin backend',
        retry: 'Retry',
        ok: 'OK',
        close: 'Close',
        cancel: 'Cancel',
        error: 'Error',
        unknown: 'unknown',
        never: 'never',
      },
    }

    // ── styles ────────────────────────────────────────────────────────────────
    /**
     * Every colour is a theme variable so the page survives a scheme switch, and
     * the glass effect is layered over `--bg`-family tokens rather than a fixed
     * white/black — a hardcoded backdrop reads as a hole in the other scheme.
     */
    const CSS = `
.mgp { display: flex; flex-direction: column; gap: 14px; font-size: 13px; line-height: 1.55; }
.mgp_card {
  position: relative; border-radius: 14px; padding: 16px 18px;
  background: color-mix(in srgb, var(--bg-soft, rgba(127,127,127,.07)) 72%, transparent);
  backdrop-filter: blur(18px) saturate(1.4); -webkit-backdrop-filter: blur(18px) saturate(1.4);
  border: 1px solid color-mix(in srgb, var(--border, rgba(127,127,127,.22)) 70%, transparent);
  box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 8px 24px -16px rgba(0,0,0,.18);
}
.mgp_card > h3 { margin: 0 0 4px; font-size: 13px; font-weight: 600; letter-spacing: .01em; }
.mgp_pitch { margin: 0 0 2px; color: var(--text-secondary, inherit); opacity: .82; }
.mgp_hint { margin: 4px 0 0; color: var(--text-secondary, inherit); opacity: .62; font-size: 12px; }
.mgp_row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mgp_kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; align-items: baseline; margin: 8px 0 0; }
.mgp_kv dt { color: var(--text-secondary, inherit); opacity: .66; }
.mgp_kv dd { margin: 0; font-variant-numeric: tabular-nums; word-break: break-all; }
.mgp_mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; }
.mgp_spacer { flex: 1 1 auto; }
.mgp_dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; }
.mgp_dot.ok { background: #2fbf71; box-shadow: 0 0 0 3px color-mix(in srgb, #2fbf71 22%, transparent); }
.mgp_dot.warn { background: #e8a33d; box-shadow: 0 0 0 3px color-mix(in srgb, #e8a33d 22%, transparent); }
.mgp_dot.bad { background: #e5534b; box-shadow: 0 0 0 3px color-mix(in srgb, #e5534b 22%, transparent); }
.mgp_btn {
  appearance: none; cursor: pointer; border-radius: 9px; padding: 6px 13px; font-size: 12.5px;
  border: 1px solid color-mix(in srgb, var(--border, rgba(127,127,127,.28)) 80%, transparent);
  background: color-mix(in srgb, var(--bg, #fff) 55%, transparent);
  color: var(--text, inherit); transition: background .15s, border-color .15s, opacity .15s;
}
.mgp_btn:hover:not(:disabled) { border-color: color-mix(in srgb, var(--primary, #4a7dff) 55%, transparent); }
.mgp_btn:disabled { opacity: .45; cursor: default; }
.mgp_btn.primary { background: color-mix(in srgb, var(--primary, #4a7dff) 88%, transparent); border-color: transparent; color: #fff; }
.mgp_table { width: 100%; border-collapse: collapse; margin-top: 10px; }
.mgp_table th, .mgp_table td { text-align: left; padding: 7px 9px; border-bottom: 1px solid color-mix(in srgb, var(--border, rgba(127,127,127,.18)) 55%, transparent); vertical-align: top; }
.mgp_table th { font-weight: 500; opacity: .62; font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; white-space: nowrap; }
.mgp_table tr:last-child td { border-bottom: none; }
.mgp_table td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.mgp_tag {
  display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 11px; margin: 1px 3px 1px 0;
  background: color-mix(in srgb, var(--primary, #4a7dff) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--primary, #4a7dff) 26%, transparent);
}
.mgp_tag.muted { background: color-mix(in srgb, var(--text, #888) 9%, transparent); border-color: color-mix(in srgb, var(--text, #888) 18%, transparent); opacity: .8; }
.mgp_tag.mgp_free { background: color-mix(in srgb, #2fbf71 16%, transparent); border-color: color-mix(in srgb, #2fbf71 34%, transparent); color: #2fbf71; font-weight: 600; }
.mgp_ratecell { display: flex; flex-direction: column; gap: 1px; align-items: flex-start; }
.mgp_cardmeta { display: none; }
.mgp_field { display: flex; flex-direction: column; gap: 5px; margin-top: 10px; }
.mgp_field label { display: flex; align-items: center; gap: 9px; cursor: pointer; }
.mgp_input {
  border-radius: 9px; padding: 6px 10px; font-size: 12.5px; font-family: var(--font-mono, ui-monospace, monospace);
  border: 1px solid color-mix(in srgb, var(--border, rgba(127,127,127,.3)) 85%, transparent);
  background: color-mix(in srgb, var(--bg, #fff) 62%, transparent); color: var(--text, inherit);
  max-width: 320px; width: 100%;
}
.mgp_input:disabled, .mgp_field input[type=checkbox]:disabled { opacity: .5; cursor: not-allowed; }
.mgp_notice {
  border-radius: 10px; padding: 10px 12px; margin-top: 10px; font-size: 12.5px;
  background: color-mix(in srgb, #e8a33d 13%, transparent);
  border: 1px solid color-mix(in srgb, #e8a33d 32%, transparent);
}
.mgp_notice.bad { background: color-mix(in srgb, #e5534b 12%, transparent); border-color: color-mix(in srgb, #e5534b 30%, transparent); }
.mgp_log { margin: 8px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
.mgp_log li { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11.5px; opacity: .78; }
.mgp_bars { display: flex; align-items: flex-end; gap: 3px; height: 46px; margin-top: 10px; }
.mgp_bar { flex: 1 1 0; min-width: 3px; border-radius: 3px 3px 0 0; background: color-mix(in srgb, var(--primary, #4a7dff) 62%, transparent); }
.mgp_stat { display: flex; flex-direction: column; gap: 1px; }
.mgp_stat b { font-size: 17px; font-variant-numeric: tabular-nums; font-weight: 600; }
.mgp_stat span { font-size: 11.5px; opacity: .62; }
.mgp_stats { display: flex; gap: 26px; flex-wrap: wrap; margin-top: 10px; }
.mgp_err { color: #e5534b; font-size: 12px; margin-top: 6px; }
.mgp_ok { color: #2fbf71; font-size: 12px; margin-top: 6px; }
@media (max-width: 720px) {
  .mgp_kv { grid-template-columns: 1fr; gap: 1px 0; }
  .mgp_kv dd { margin-bottom: 6px; }
  /* On a phone the wide table's action column is pushed off-screen and there is
     no horizontal scroll to reach it, so "show/hide" was unreachable. The list
     therefore collapses to stacked cards: every control stays on screen and the
     rate is a tag, not a column that the media query used to hide. */
  .mgp_table.mgp_models thead { display: none; }
  .mgp_table.mgp_models, .mgp_table.mgp_models tbody { display: block; width: 100%; }
  .mgp_table.mgp_models tr { display: block; border: 1px solid color-mix(in srgb, var(--border, rgba(127,127,127,.22)) 60%, transparent); border-radius: 10px; padding: 10px 12px; margin-top: 10px; }
  .mgp_table.mgp_models td { display: block; border: none; padding: 2px 0; }
  .mgp_table.mgp_models td[data-col='actions'] { margin-top: 8px; }
  /* The stacked meta row replaces these separate columns on a phone. */
  .mgp_table.mgp_models td[data-col='rate'],
  .mgp_table.mgp_models td[data-col='owner'],
  .mgp_table.mgp_models td[data-col='ctx'],
  .mgp_table.mgp_models td[data-col='out'],
  .mgp_table.mgp_models td[data-col='in'],
  .mgp_table.mgp_models td[data-col='think'] { display: none; }
  .mgp_table.mgp_models td[data-col='id'] { display: block; }
  .mgp_cardmeta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; align-items: center; }
}
`

    // ── data ──────────────────────────────────────────────────────────────────
    /**
     * One API call with a timeout.
     *
     * The 8s bound is not arbitrary: with no timeout, a route that is not
     * registered (a host half that failed to mount) hangs the fetch forever, and
     * this page then shows its spinner instead of the "could not reach the
     * backend" line that tells the user what is actually wrong.
     *
     * @param {string} path
     * @param {{ method?: string, body?: unknown, timeout?: number }} [options]
     */
    async function api(path, options) {
      const { timeout = 8000, body, ...rest } = options ?? {}
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, {
          ...rest,
          ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
          redirect: 'error',
          signal: ctrl.signal,
        })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 300) } }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${String(response.status)}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * Load-once-with-reload state, so every card can show its own error and its
     * own retry rather than the whole page depending on one promise.
     */
    function useAsync(load, deps) {
      const [value, setValue] = useState(undefined)
      const [error, setError] = useState(null)
      const [nonce, setNonce] = useState(0)
      useEffect(() => {
        let alive = true
        setError(null)
        Promise.resolve()
          .then(() => load())
          .then(payload => { if (alive) setValue(payload) })
          .catch(cause => { if (alive) setError(String(cause?.message ?? cause)) })
        return () => { alive = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [...(deps ?? []), nonce])
      return { value, error, reload: () => setNonce(n => n + 1), setValue }
    }

    /** Format a token count so a table stays scannable. */
    function tokens(n) {
      const v = Number(n)
      if (!Number.isFinite(v) || v === 0) return '0'
      if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`
      if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
      return String(v)
    }

    /** Format a context window the way model pages do. */
    function context(n) {
      const v = Number(n)
      if (!Number.isFinite(v)) return '—'
      return v >= 1000 ? `${String(Math.round(v / 1000))}k` : String(v)
    }

    /** A wall-clock stamp for the event log and the recent-turns list. */
    function stamp(at) {
      const ms = Number(at)
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const d = new Date(ms)
      return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    }

    // ── cards ─────────────────────────────────────────────────────────────────
    function GatewayCard({ t, status, reload, busy, setBusy }) {
      const gateway = status?.gateway ?? {}
      const enabled = status?.enabled !== false
      const ready = gateway.ready === true
      const mode = gateway.mode ?? null
      const [notice, setNotice] = useState(null)

      const act = async (action) => {
        setBusy(true); setNotice(null)
        try {
          const result = await api('/gateway', { body: { action }, timeout: 40000 })
          if (action !== 'status' && result?.ready !== true) {
            setNotice({ kind: 'warn', text: action === 'stop' ? '' : String(result?.error ?? t('state.notReady')) })
          }
        } catch (error) {
          setNotice({ kind: 'bad', text: String(error?.message ?? error) })
        } finally {
          setBusy(false)
          reload()
        }
      }

      const dot = !enabled ? 'bad' : ready ? 'ok' : 'warn'
      const stateText = !enabled ? t('state.off') : ready ? t('state.ready') : t('state.notReady')

      return h('section', { className: 'mgp_card' },
        h('h3', null, t('gateway.title')),
        h('div', { className: 'mgp_row' },
          h('span', { className: `mgp_dot ${dot}` }),
          h('span', null, stateText),
          mode === null || mode === undefined ? null : h('span', { className: 'mgp_hint' }, `· ${t(`gateway.mode.${mode}`)}`),
          h('span', { className: 'mgp_spacer' }),
          enabled && mode !== null
            ? h(Fragment, null,
                h('button', { className: 'mgp_btn', disabled: busy, onClick: () => act('restart') }, t('gateway.restart')),
                gateway.mode === 'spawned'
                  ? h('button', { className: 'mgp_btn', disabled: busy, onClick: () => act('stop') }, t('gateway.stop'))
                  : null)
            : h('button', { className: 'mgp_btn primary', disabled: busy, onClick: () => act('start') }, t('gateway.start'))),
        status?.magpieError
          ? h('div', { className: 'mgp_notice bad' },
              h('div', null, t('gateway.missing')),
              h('code', { className: 'mgp_mono' }, status.magpieError),
              h('div', { style: { marginTop: '6px' } }, h('code', { className: 'mgp_mono' }, t('gateway.installCmd'))))
          : null,
        h('dl', { className: 'mgp_kv' },
          h('dt', null, t('gateway.addr')), h('dd', { className: 'mgp_mono' }, gateway.addr || '—'),
          h('dt', null, t('gateway.magpie')), h('dd', { className: 'mgp_mono' }, status?.magpie?.version ?? t('unknown')),
          gateway.pid ? h(Fragment, null, h('dt', null, t('gateway.pid')), h('dd', { className: 'mgp_mono' }, String(gateway.pid))) : null,
          h('dt', null, t('gateway.restarts')), h('dd', null, String(gateway.restarts ?? 0)),
          gateway.webUrl
            ? h(Fragment, null,
                h('dt', null, t('gateway.page')),
                h('dd', null, h('a', { className: 'mgp_mono', href: gateway.webUrl, target: '_blank', rel: 'noreferrer' }, gateway.webUrl)))
            : null),
        notice?.text ? h('div', { className: `mgp_notice ${notice.kind}` }, notice.text) : null)
    }

    function DnsCard({ t, status }) {
      const dns = status?.dns ?? {}
      const listening = Array.isArray(dns.listening) ? dns.listening : []
      const failed = Array.isArray(dns.failed) ? dns.failed : []
      const dot = dns.enabled === true ? (listening.length > 0 ? 'ok' : 'bad') : 'warn'
      return h('section', { className: 'mgp_card' },
        h('h3', null, t('dns.title')),
        h('p', { className: 'mgp_hint' }, t('dns.why')),
        h('div', { className: 'mgp_row', style: { marginTop: '10px' } },
          h('span', { className: `mgp_dot ${dot}` }),
          h('span', null, dns.enabled === true ? (listening.length > 0 ? listening.join(', ') : t('dns.failed')) : t('state.off'))),
        h('dl', { className: 'mgp_kv' },
          h('dt', null, t('dns.upstream')), h('dd', { className: 'mgp_mono' }, '223.5.5.5 · 119.29.29.29 · 8.8.8.8'),
          h('dt', null, t('dns.queries')), h('dd', null, String(dns.queries ?? 0)),
          failed.length > 0 ? h(Fragment, null, h('dt', null, t('dns.failed')), h('dd', { className: 'mgp_mono' }, failed.join('; '))) : null),
        dns.enabled === true && listening.length === 0 ? h('div', { className: 'mgp_notice' }, t('dns.needRoot')) : null)
    }

    /**
     * The billing cell: a free badge, the multiplier, and the list price. The
     * multiplier (`rate`) is what magpie's own provider page shows; the price is
     * the provider's list price per 1M tokens. All of it comes from magpie's web
     * API — this cell never invents a number, so when the gateway reports none it
     * shows a neutral dash.
     */
    function RateCell({ t, rates }) {
      if (rates === undefined || rates === null || (rates.rate === undefined && rates.list === undefined)) {
        return h('span', { style: { opacity: '.4' } }, '—')
      }
      if (rates.free === true) {
        return h('span', { className: 'mgp_tag mgp_free' }, t('models.free'))
      }
      return h('div', { className: 'mgp_ratecell' },
        typeof rates.rate === 'number'
          ? h('span', { className: 'mgp_tag' }, `${String(rates.rate)}×`)
          : null,
        rates.list && (typeof rates.list.input === 'number' || typeof rates.list.output === 'number')
          ? h('div', { className: 'mgp_mono mgp_hint', style: { fontSize: '11px', marginTop: '2px' } },
              `${typeof rates.list.input === 'number' ? `$${String(rates.list.input)}` : '—'} / ${typeof rates.list.output === 'number' ? `$${String(rates.list.output)}` : '—'} ${t('models.perM')}`)
          : null)
    }

    function ModelsCard({ t, models, error, reload, busy, setBusy, settings }) {
      const [tests, setTests] = useState({})
      const [saving, setSaving] = useState(false)
      const list = Array.isArray(models?.models) ? models.models : []

      // Curation state: `visibleModels` empty means "everything, catalog order".
      // The per-row toggle turns that into an explicit ordered list on first use —
      // seeding it from the current order so the picker does not visibly reshuffle.
      const visible = Array.isArray(settings?.visibleModels) ? settings.visibleModels : []
      const curated = visible.length > 0
      const isShown = id => (curated ? visible.includes(id) : true)
      const orderedIds = () => (curated ? visible : list.map(m => m.id))

      const toggle = async (id) => {
        const current = orderedIds()
        const next = isShown(id) ? current.filter(x => x !== id) : [...current, id]
        // Showing everything again collapses back to the empty "all" form.
        const payload = next.length === list.length ? [] : next
        setSaving(true)
        try {
          await api('/settings', { body: { visibleModels: payload }, timeout: 15000 })
        } catch { /* the reload below reflects reality */ }
        setSaving(false)
        reload()
      }

      const test = async (model, efforts) => {
        setTests(prev => ({ ...prev, [model]: { running: true } }))
        try {
          // Testing a thinking model at its own top level exercises the effort
          // path, not just connectivity: an effort the gateway ignores would pass
          // a plain round trip and only show up as reasoning_tokens that never move.
          const effort = Array.isArray(efforts) && efforts.length > 0 ? efforts[efforts.length - 1] : undefined
          const result = await api('/test', { body: effort === undefined ? { model } : { model, effort }, timeout: 90000 })
          setTests(prev => ({ ...prev, [model]: { running: false, result } }))
        } catch (cause) {
          setTests(prev => ({ ...prev, [model]: { running: false, result: { ok: false, error: String(cause?.message ?? cause) } } }))
        }
      }

      const refreshing = async () => {
        setBusy(true)
        try { await api('/refresh', { body: { force: true }, timeout: 30000 }) } catch { /* the reload below reports it */ }
        setBusy(false)
        reload()
      }

      return h('section', { className: 'mgp_card' },
        h('div', { className: 'mgp_row' },
          h('h3', { style: { margin: 0 } }, `${t('models.title')} · ${String(list.length)} ${t('models.count')}`),
          h('span', { className: 'mgp_spacer' }),
          h('button', { className: 'mgp_btn', disabled: busy, onClick: refreshing }, t('models.refresh'))),
        h('p', { className: 'mgp_hint' }, t('models.curatedHint')),
        error ? h('div', { className: 'mgp_err' }, error) : null,
        list.length === 0 && !error
          ? h('div', { className: 'mgp_notice' }, t('models.empty'))
          : null,
        list.length === 0 ? null : h('table', { className: 'mgp_table mgp_models' },
          h('thead', null, h('tr', null,
            h('th', null, t('models.col.id')),
            h('th', null, t('models.col.owner')),
            h('th', null, t('models.col.rate')),
            h('th', null, t('models.col.context')),
            h('th', null, t('models.col.output')),
            h('th', null, t('models.col.input')),
            h('th', null, t('models.col.thinking')),
            h('th', null, ''))),
          h('tbody', null, list.map(model => {
            const state = tests[model.id]
            const shown = isShown(model.id)
            return h('tr', { key: model.id, style: shown ? undefined : { opacity: '.5' } },
              h('td', { 'data-col': 'id' },
                h('div', null, model.name),
                h('div', { className: 'mgp_mono', style: { opacity: '.62' } }, model.id),
                model.group ? h('span', { className: 'mgp_tag muted' }, t('models.group')) : null,
                // On a phone the rate/context/output/thinking columns collapse into
                // this stacked tag row, so nothing is lost when the table stacks.
                h('div', { className: 'mgp_cardmeta' },
                  h(RateCell, { t, rates: model.rates }),
                  h('span', { className: 'mgp_tag muted' }, `${t('models.ctxLabel')} ${context(model.contextWindow)}`),
                  h('span', { className: 'mgp_tag muted' }, `${t('models.outLabel')} ${tokens(model.maxOutput)}`),
                  (model.efforts ?? []).length > 0
                    ? h('span', { className: 'mgp_tag muted' }, (model.efforts ?? []).join('/'))
                    : null),
                state?.result
                  ? h('div', { className: state.result.ok ? 'mgp_ok' : 'mgp_err' },
                      state.result.ok
                        ? `${String(state.result.ms)}ms · ${String(state.result.reasoningTokens ?? 0)} reasoning tok · ${JSON.stringify(String(state.result.reply ?? '').slice(0, 40))}`
                        : String(state.result.error ?? ''))
                  : null),
              h('td', { 'data-col': 'owner' }, model.ownedBy ?? '—'),
              h('td', { className: 'num', 'data-col': 'rate' }, h(RateCell, { t, rates: model.rates })),
              h('td', { className: 'num', 'data-col': 'ctx' }, context(model.contextWindow)),
              h('td', { className: 'num', 'data-col': 'out' }, tokens(model.maxOutput)),
              h('td', { 'data-col': 'in' }, model.vision ? t('models.vision') : t('models.textOnly')),
              h('td', { 'data-col': 'think' }, (model.efforts ?? []).length === 0
                ? h('span', { style: { opacity: '.5' } }, '—')
                : (model.efforts ?? []).map(level => h('span', { key: level, className: 'mgp_tag muted' }, level))),
              h('td', { 'data-col': 'actions' },
                h('div', { className: 'mgp_row', style: { gap: '6px' } },
                  h('button', {
                    className: 'mgp_btn', disabled: saving,
                    title: shown ? t('models.hide') : t('models.show'),
                    onClick: () => toggle(model.id),
                  }, shown ? `✓ ${t('models.show')}` : t('models.hide')),
                  h('button', {
                    className: 'mgp_btn',
                    disabled: state?.running === true,
                    onClick: () => test(model.id, model.efforts),
                  }, state?.running === true ? t('models.testing') : t('models.test')))))
          }))))
    }

    function UsageCard({ t, stats, error }) {
      const total = stats?.total ?? {}
      const models = Array.isArray(stats?.models) ? stats.models : []
      const series = Array.isArray(stats?.series) ? stats.series : []
      const peak = series.reduce((max, day) => Math.max(max, Number(day.outputTokens) + Number(day.inputTokens)), 0)
      return h('section', { className: 'mgp_card' },
        h('h3', null, t('usage.title')),
        error ? h('div', { className: 'mgp_err' }, error) : null,
        h('div', { className: 'mgp_stats' },
          h('div', { className: 'mgp_stat' }, h('b', null, String(total.turns ?? 0)), h('span', null, t('usage.turns'))),
          h('div', { className: 'mgp_stat' }, h('b', null, tokens(total.inputTokens)), h('span', null, t('usage.input'))),
          h('div', { className: 'mgp_stat' }, h('b', null, tokens(total.outputTokens)), h('span', null, t('usage.output'))),
          h('div', { className: 'mgp_stat' }, h('b', null, tokens(total.reasoningTokens)), h('span', null, t('usage.reasoning'))),
          h('div', { className: 'mgp_stat' }, h('b', null, tokens(total.cacheReadTokens)), h('span', null, t('usage.cacheRead')))),
        // A bar per day, height scaled to the busiest day: the point is the shape
        // of the week, not the numbers, which the stats above already give.
        series.length > 0
          ? h('div', { className: 'mgp_bars', title: series.map(d => `${d.day}: ${String(d.turns)}`).join('\n') },
              series.map(day => {
                const v = Number(day.outputTokens) + Number(day.inputTokens)
                return h('div', {
                  key: day.day,
                  className: 'mgp_bar',
                  style: { height: `${String(Math.max(4, peak > 0 ? Math.round((v / peak) * 100) : 4))}%` },
                })
              }))
          : null,
        models.length === 0
          ? h('p', { className: 'mgp_hint' }, t('usage.empty'))
          : h('table', { className: 'mgp_table' },
              h('thead', null, h('tr', null,
                h('th', null, t('usage.byModel')),
                h('th', null, t('usage.turns')),
                h('th', null, t('usage.input')),
                h('th', null, t('usage.output')),
                h('th', null, t('usage.reasoning')))),
              h('tbody', null, models.slice(0, 12).map(row => h('tr', { key: row.model },
                h('td', { className: 'mgp_mono' }, row.model),
                h('td', { className: 'num' }, String(row.turns ?? 0)),
                h('td', { className: 'num' }, tokens(row.inputTokens)),
                h('td', { className: 'num' }, tokens(row.outputTokens)),
                h('td', { className: 'num' }, tokens(row.reasoningTokens)))))))
    }

    function SettingsCard({ t, status, reload, setBusy }) {
      const settings = status?.settings ?? {}
      /**
       * Fields a bundle patch pins. They are rendered locked rather than hidden:
       * a switch that silently cannot be changed is worse than one that says why,
       * and the host refuses the write with 409 anyway — so this is the page
       * agreeing with the host instead of discovering it after a click.
       */
      const pinned = new Set(Array.isArray(status?.pinned) ? status.pinned : [])
      const [form, setForm] = useState(null)
      const [saved, setSaved] = useState(null)
      const [error, setError] = useState(null)
      const draft = form ?? settings
      // A settings write can fail on magpie's own rules (a page key shorter than
      // 16 characters is refused by the binary), so the error is shown verbatim:
      // a generic "could not save" sends the user to guess which field was wrong.
      const set = (key, value) => { setForm({ ...draft, [key]: value }); setSaved(null); setError(null) }

      const save = async () => {
        setBusy(true); setError(null); setSaved(null)
        try {
          const result = await api('/settings', { body: form ?? {} })
          setSaved(true); setForm(null)
          reload()
          void result
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally { setBusy(false) }
      }

      const checkbox = (key, label, hint) => h('div', { className: 'mgp_field' },
        h('label', { ...(pinned.has(key) ? { title: t('settings.pinned') } : {}) },
          h('input', {
            type: 'checkbox', checked: draft[key] === true, disabled: pinned.has(key),
            onChange: e => set(key, e.target.checked),
          }),
          h('span', null, label),
          pinned.has(key) ? h('span', { className: 'mgp_tag muted' }, t('settings.pinnedTag')) : null),
        h('span', { className: 'mgp_hint' }, hint))

      const text = (key, label, hint, placeholder) => h('div', { className: 'mgp_field' },
        h('label', { htmlFor: `mgp-${key}` }, h('span', null, label)),
        h('input', {
          id: `mgp-${key}`, className: 'mgp_input', value: String(draft[key] ?? ''), disabled: pinned.has(key),
          placeholder: placeholder ?? '', onChange: e => set(key, e.target.value),
        }),
        h('span', { className: 'mgp_hint' }, hint))

      return h('section', { className: 'mgp_card' },
        h('h3', null, t('settings.title')),
        checkbox('enabled', t('settings.enabled'), t('settings.enabledHint')),
        checkbox('dns', t('settings.dns'), t('settings.dnsHint')),
        checkbox('autoFallback', t('settings.autoFallback'), t('settings.autoFallbackHint')),
        checkbox('serveWeb', t('settings.serveWeb'), t('settings.serveWebHint')),
        text('addr', t('settings.addr'), t('settings.addrHint'), '127.0.0.1:3425'),
        draft.serveWeb === true ? text('webAddr', t('settings.webAddr'), '', '127.0.0.1:3430') : null,
        draft.serveWeb === true ? text('webKey', t('settings.webKey'), t('settings.webKeyHint'), 'magpie-dsh-local') : null,
        h('div', { className: 'mgp_field' },
          h('label', { htmlFor: 'mgp-refreshMinutes' }, h('span', null, t('settings.refresh'))),
          h('input', {
            id: 'mgp-refreshMinutes', className: 'mgp_input', type: 'number', min: '0', max: '1440',
            value: String(draft.refreshMinutes ?? 10),
            onChange: e => set('refreshMinutes', Number(e.target.value)),
          }),
          h('span', { className: 'mgp_hint' }, t('settings.refreshHint'))),
        h('div', { className: 'mgp_row', style: { marginTop: '14px' } },
          h('button', { className: 'mgp_btn primary', onClick: save, disabled: form === null }, t('settings.save')),
          form !== null ? h('button', { className: 'mgp_btn', onClick: () => { setForm(null); setError(null); setSaved(null) } }, t('cancel')) : null,
          h('span', { className: 'mgp_spacer' }),
          saved === true ? h('span', { className: 'mgp_ok' }, t('settings.saved')) : null),
        error ? h('div', { className: 'mgp_err' }, error) : null,
        form !== null ? h('p', { className: 'mgp_hint' }, t('settings.applyHint')) : null)
    }

    function LogCard({ t, status }) {
      const event = status?.lastEvent ?? null
      return h('section', { className: 'mgp_card' },
        h('h3', null, t('log.title')),
        event === null
          ? h('p', { className: 'mgp_hint' }, t('log.empty'))
          : h('ul', { className: 'mgp_log' },
              h('li', null, `${stamp(event.at)} · ${String(event.type)}${event.addr ? ` · ${event.addr}` : ''}${event.error ? ` · ${event.error}` : ''}${typeof event.code === 'number' ? ` · code ${String(event.code)}` : ''}${typeof event.signal === 'string' ? ` · ${event.signal}` : ''}`),
              status?.catalogError ? h('li', null, `${stamp(status.catalogAt)} · catalog: ${status.catalogError}`) : null,
              status?.catalogAt ? h('li', null, `${stamp(status.catalogAt)} · catalog synced · ${String(status.modelCount ?? 0)} models`) : null))
    }

    // ── the page ──────────────────────────────────────────────────────────────
    function SettingsPage(props) {
      const t = props.locale === undefined ? props.t : Object.assign(x => props.t(x), { locale: props.locale })
      const [busy, setBusy] = useState(false)
      const status = useAsync(() => api('/status'), [])
      const models = useAsync(() => api('/models'), [])
      const stats = useAsync(() => api('/stats'), [])

      /** Re-read everything the page shows; one button, one consistent snapshot. */
      const reload = useCallback(() => { status.reload(); models.reload(); stats.reload() }, [status, models, stats])

      // Poll the status while the page is open: the gateway is supervised, so its
      // state changes without any user action here (a crash restarts it, a catalog
      // sync lands on a timer), and a page that only read once would report a
      // process that died ten minutes ago as ready.
      useEffect(() => {
        const timer = setInterval(() => { if (!busy) status.reload() }, 8000)
        return () => clearInterval(timer)
      }, [status, busy])

      if (status.error !== null && status.value === undefined) {
        return h('div', { className: 'mgp' },
          h('section', { className: 'mgp_card' },
            h('h3', null, t('title')),
            h('div', { className: 'mgp_notice bad' }, `${t('loadFailed')}: ${status.error}`),
            h('div', { className: 'mgp_row', style: { marginTop: '12px' } },
              h('button', { className: 'mgp_btn', onClick: status.reload }, t('retry')))))
      }
      if (status.value === undefined) {
        return h('div', { className: 'mgp' }, h('section', { className: 'mgp_card' }, h('p', { className: 'mgp_hint' }, t('loading'))))
      }

      return h('div', { className: 'mgp' },
        h('section', { className: 'mgp_card' },
          h('h3', null, t('title')),
          h('p', { className: 'mgp_pitch' }, t('pitch'))),
        h(GatewayCard, { t, status: status.value, reload, busy, setBusy }),
        h(DnsCard, { t, status: status.value }),
        h(ModelsCard, { t, models: models.value, error: models.error ?? status.value?.catalogError ?? null, reload, busy, setBusy, settings: status.value?.settings }),
        h(UsageCard, { t, stats: stats.value, error: stats.error }),
        h(SettingsCard, { t, status: status.value, reload, setBusy }),
        h(LogCard, { t, status: status.value }))
    }

    // ── mounting ──────────────────────────────────────────────────────────────
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'magpie-model: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-magpie-model')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'magpie-model: styles')

      /**
       * The locale tag, read at render time from `<html lang>`: the shell mirrors
       * the active language there, so a render-time read survives a language
       * switch without this plugin owning a subscription.
       */
      function localeTag() {
        try {
          const snapshot = typeof ctx.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale?.getSnapshot?.()
          const value = snapshot?.active ?? ctx.locale?.locale
          return typeof value === 'string' ? value : document.documentElement.lang || 'en'
        } catch { return 'en' }
      }

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'magpie-model',
        // After the stock sections, beside the other model providers rather than
        // ahead of them: a plugin that sorts itself to the top of someone's
        // settings list is advertising, not integrating.
        order: 36,
        label: () => t('nav'),
        locale: NS,
      }, props => h(SettingsPage, { ...props, locale: localeTag(), ctx })))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'magpie-model'
    exports.__test = { api, tokens, context, stamp, DICT, SettingsPage, GatewayCard, DnsCard, ModelsCard, UsageCard, SettingsCard, LogCard }
    return module.exports
  },
})
