/**
 * Lint the browser half without a build step or a browser.
 *
 * client.js is a hand-written ModuleLoader bundle: it runs inside the web shell's
 * `window.__ModuleLoader__.load`, so `node --check` alone does not prove it works
 * — the factory body is only evaluated when the loader calls it. This harness
 * provides that loader plus a minimal React/document stub and runs the factory for
 * real, which is what catches an undefined variable or a bad destructuring inside
 * the component bodies.
 *
 * It also asserts the two dictionaries agree on their key set: a key present in
 * `zh` but missing from `en` renders as the raw key string in the English UI,
 * which is the kind of bug nobody notices until a screenshot leaks.
 *
 * Run: node test/client-lint.mjs
 */
import vm from 'node:vm'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

/** A React stub: `createElement` records the tag so a mistyped h() call is visible. */
const reactStub = new Proxy({
  createElement: (tag) => ({ tag }),
  Fragment: 'Fragment',
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
}, { get: (target, prop) => (prop in target ? target[prop] : undefined) })

let loaded = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(descriptor) {
        const required = []
        const req = (id) => {
          required.push(id)
          if (id === 'react') return reactStub
          // `react-dom` is probed defensively by the bundle; answering undefined
          // exercises its fallback path rather than its portal path.
          if (id === 'react-dom') return undefined
          throw new Error(`client.js required an unexpected module: ${id}`)
        }
        loaded = { exports: descriptor.factory(req), required }
        return loaded.exports
      },
    },
  },
  document: {
    createElement: () => ({ setAttribute() {}, style: {}, textContent: '' }),
    head: { appendChild() {} },
    documentElement: { lang: 'zh' },
  },
  console,
  fetch: () => { throw new Error('client lint must not perform network I/O') },
  EventSource: undefined,
  setTimeout, clearTimeout, setInterval, clearInterval,
  URL, AbortController, TextDecoder,
}
vm.createContext(sandbox)

// 1) the bundle evaluates under the loader at all
new vm.Script(src, { filename: 'client.js' }).runInContext(sandbox)
if (loaded === null) throw new Error('the ModuleLoader was never called')

const exports = loaded.exports
const problems = []
if (exports.name !== 'magpie-model') problems.push(`exports.name is ${String(exports.name)}, expected magpie-model`)
if (typeof exports.apply !== 'function') problems.push('exports.apply is not a function')
if (!Array.isArray(exports.inject)) problems.push('exports.inject is not an array')
else {
  for (const dep of exports.inject) {
    if (dep !== 'slots' && dep !== 'locale') problems.push(`client inject names "${dep}", but the browser half only needs slots and locale`)
  }
}
if (!loaded.required.includes('react')) problems.push('the bundle never required react')

// 2) the two dictionaries agree
const DICT = exports.__test?.DICT
if (DICT === undefined) problems.push('exports.__test.DICT is missing')
else {
  const zh = new Set(Object.keys(DICT.zh))
  const en = new Set(Object.keys(DICT.en))
  const onlyZh = [...zh].filter(key => !en.has(key))
  const onlyEn = [...en].filter(key => !zh.has(key))
  if (onlyZh.length > 0) problems.push(`keys missing from en: ${onlyZh.join(', ')}`)
  if (onlyEn.length > 0) problems.push(`keys missing from zh: ${onlyEn.join(', ')}`)
  for (const [locale, dict] of Object.entries(DICT)) {
    for (const [key, value] of Object.entries(dict)) {
      if (typeof value !== 'string' || value.trim() === '') problems.push(`${locale}.${key} is not a non-empty string`)
    }
  }
  process.stdout.write(`  dictionaries: ${String(zh.size)} keys each, in parity\n`)
}

// 3) every component in __test renders without throwing
const components = Object.entries(exports.__test ?? {}).filter(([, value]) => typeof value === 'function' && /^[A-Z]/.test(String(value.name)))
const t = (key) => `[[${key}]]`
const renderable = {
  status: { version: '1.0.0', enabled: true, pinned: ['addr'], magpie: { version: '0.1.2119' }, magpieError: null,
    gateway: { addr: '127.0.0.1:3425', mode: 'spawned', ready: true, pid: 1234, restarts: 0, webUrl: null },
    dns: { enabled: true, listening: ['127.0.0.1:53'], failed: [], queries: 3 },
    catalogError: null, catalogAt: Date.now(), lastEvent: { type: 'ready', at: Date.now(), addr: '127.0.0.1:3425' },
    settings: { enabled: true, addr: '', serveWeb: true, webAddr: '', webKey: 'magpie-dsh-local', dns: true, refreshMinutes: 10 },
    modelCount: 2 },
  models: { models: [
    { id: 'workbuddy/hy3', name: 'Hy3', ownedBy: 'workbuddy', group: false, reasoning: true, contextWindow: 192000, maxOutput: 64000, vision: true, inputModalities: ['text', 'image'], efforts: ['low', 'high'], rates: { free: true } },
    { id: 'workbuddy/deepseek-v4-pro', name: 'DeepSeek-V4-Pro', ownedBy: 'workbuddy', group: false, reasoning: true, contextWindow: 1000000, maxOutput: 128000, vision: true, inputModalities: ['text', 'image'], efforts: ['none', 'high', 'xhigh'], rates: { rate: 0.51, list: { input: 0.66, output: 1.98, cacheRead: 0.022 } } },
    { id: 'group/cheap-first', name: '便宜优先', group: true, reasoning: true, contextWindow: 1000000, maxOutput: 131072, vision: true, inputModalities: ['text', 'image'], efforts: ['high'] },
  ] },
  stats: { total: { turns: 3, inputTokens: 1200, outputTokens: 340, reasoningTokens: 90, cacheReadTokens: 0 },
    models: [{ model: 'workbuddy/hy3', turns: 3, inputTokens: 1200, outputTokens: 340, reasoningTokens: 90 }],
    series: [{ day: '2026-10-30', turns: 3, inputTokens: 1200, outputTokens: 340 }], recentTurns: [] },
}
for (const [name, Component] of components) {
  if (name === 'SettingsPage') continue // needs ctx/slots; covered below
  try {
    Component({ t, locale: 'zh', ...renderable, reload: () => {}, busy: false, setBusy: () => {}, error: null })
    process.stdout.write(`  ${name} renders\n`)
  } catch (error) {
    problems.push(`${name} threw while rendering: ${error.message}`)
  }
}

// 4) the page component itself, plus the pure helpers
try {
  const page = exports.__test.SettingsPage({ t, locale: 'zh', ctx: {} })
  if (page === undefined) problems.push('SettingsPage rendered nothing at all')
  process.stdout.write('  SettingsPage renders\n')
} catch (error) {
  problems.push(`SettingsPage threw: ${error.message}`)
}
const { tokens, context, stamp } = exports.__test
if (tokens(0) !== '0' || tokens(1500) !== '1.5k' || tokens(2500000) !== '2.5M') problems.push(`tokens() formats wrong: ${tokens(1500)} ${tokens(2500000)}`)
if (context(192000) !== '192k') problems.push(`context() formats wrong: ${context(192000)}`)
if (stamp(0) !== '' || stamp(Date.now()) === '') problems.push('stamp() formats wrong')
process.stdout.write('  helpers format numbers and timestamps\n')

if (problems.length > 0) {
  process.stdout.write(`\nclient lint FAILED:\n${problems.map(p => `  - ${p}`).join('\n')}\n`)
  process.exit(1)
}
process.stdout.write('\nclient lint ok\n')
