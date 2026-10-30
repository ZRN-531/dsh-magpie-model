/**
 * Post-restart live verification for the magpie-model plugin.
 *
 * The engine restart that loads this plugin also restarts the process that hosts
 * the agent's tools, so nothing in-conversation survives the moment of restart.
 * This script is the durable half: it is on disk, it needs no agent context, and
 * it answers the one question that matters after the restart — did the plugin
 * come up, adopt or spawn its gateway, resolve DNS, and publish models into the
 * harness picker?
 *
 * It reads the launch token out of engine.log, exchanges it for a session cookie
 * over /connect (the same handshake the web shell performs), then calls the
 * plugin's own status and models routes through the host's trust fence — so it
 * verifies the real authenticated path a browser would take, not a loopback
 * shortcut that skips admission.
 *
 * Run: node test/verify-live.mjs [--wait <seconds>]
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = process.env.DSH_HOME ?? os.homedir()
const PREFIX = process.env.PREFIX ?? path.join(path.dirname(HOME), 'engine')
const ENGINE_LOG = path.join(PREFIX, 'engine.log')
const WEB = 'http://127.0.0.1:3080'
const waitArg = Number(process.argv[process.argv.indexOf('--wait') + 1] ?? 90)
const WAIT_S = Number.isFinite(waitArg) && waitArg > 0 ? waitArg : 90

const line = (label, ok, detail = '') =>
  process.stdout.write(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
const info = (label, detail) => process.stdout.write(`  ${label}: ${detail}\n`)

/** The most recent launch token the engine printed. */
function latestToken() {
  try {
    const text = fs.readFileSync(ENGINE_LOG, 'utf8')
    const matches = [...text.matchAll(/token=([A-Za-z0-9_-]+)/g)]
    return matches.length > 0 ? matches[matches.length - 1][1] : null
  } catch { return null }
}

/** The listening local ports, read from /proc/net without needing ss/netstat. */
function listeningTcp() {
  const out = new Set()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      for (const row of fs.readFileSync(file, 'utf8').split('\n').slice(1)) {
        const cols = row.trim().split(/\s+/)
        if (cols.length < 4 || cols[3] !== '0A') continue // 0A = LISTEN
        const port = parseInt(cols[1].split(':')[1], 16)
        if (Number.isFinite(port)) out.add(port)
      }
    } catch { /* the file may not exist on every kernel */ }
  }
  return out
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  process.stdout.write(`verifying the magpie-model plugin (waiting up to ${String(WAIT_S)}s for the engine)\n\n`)

  // ── 1. the engine answers, with a valid launch token ───────────────────────
  const deadline = Date.now() + WAIT_S * 1000
  let token = null
  let engineUp = false
  while (Date.now() < deadline) {
    token = latestToken()
    if (token !== null) {
      try {
        await fetch(`${WEB}/api/magpie-model/status`) // any answer (even 401) means it is up
        engineUp = true
        break
      } catch { await sleep(1500) }
    } else await sleep(1500)
  }
  line('engine is up on :3080', engineUp, engineUp ? '' : 'no HTTP answer within the wait')
  if (!engineUp) { process.exit(1) }
  line('a launch token was found in engine.log', token !== null)
  if (token === null) process.exit(1)

  // ── 2. the /connect handshake issues a session cookie ──────────────────────
  const connect = await fetch(`${WEB}/connect?token=${token}`, { redirect: 'manual' })
  const cookies = connect.headers.getSetCookie ? connect.headers.getSetCookie() : []
  const jar = cookies.map(c => c.split(';')[0]).join('; ')
  const authed = connect.status === 302 && jar !== ''
  line('the /connect handshake issued a session cookie', authed, `status ${String(connect.status)}, ${String(cookies.length)} cookie(s)`)
  if (!authed) process.exit(1)

  const get = async (route) => {
    const r = await fetch(`${WEB}${route}`, { headers: { cookie: jar } })
    return { status: r.status, body: await r.json().catch(() => null) }
  }

  // ── 3. the plugin's host half mounted and registered its API ───────────────
  const status = await get('/api/magpie-model/status')
  line('the plugin API is mounted (host half loaded)', status.status === 200, `status ${String(status.status)}`)
  if (status.status !== 200 || status.body === null) {
    info('note', 'a 404 here means the bundle was skipped at load — check engine.log for "cannot resolve profile bundle"')
    process.exit(1)
  }
  const s = status.body
  info('plugin version', String(s.version))
  info('enabled', String(s.enabled))
  line('the plugin is enabled', s.enabled === true, s.enabled ? '' : 'settings.json says enabled:false')
  info('magpie binary', s.magpie ? `${s.magpie.command} (v${s.magpie.version})` : `NOT FOUND: ${String(s.magpieError)}`)
  line('magpie was located', s.magpie !== null && s.magpie !== undefined)

  // ── 4. the gateway is live (adopted or spawned by the plugin) ──────────────
  const gw = s.gateway ?? {}
  line('the gateway is running', gw.ready === true, `mode ${String(gw.mode)}, addr ${String(gw.addr)}`)
  info('gateway source', gw.mode === 'adopted' ? 'adopted an existing magpie' : gw.mode === 'spawned' ? `spawned by the plugin (pid ${String(gw.pid)})` : 'not running')
  info('web console', gw.webUrl ?? '(not served)')

  // ── 5. the DNS forwarder is listening (the Android-specific fix) ───────────
  const dns = s.dns ?? {}
  const tcp = listeningTcp()
  line('the DNS forwarder is on', dns.enabled === true)
  info('dns listening', Array.isArray(dns.listening) && dns.listening.length > 0 ? dns.listening.join(', ') : 'nothing bound')
  if (Array.isArray(dns.failed) && dns.failed.length > 0) info('dns bind failures', dns.failed.join('; '))

  // ── 6. models were synced from the gateway into the harness picker ─────────
  const models = await get('/api/magpie-model/models')
  const list = Array.isArray(models.body?.models) ? models.body.models : []
  line('models were synced from the gateway', list.length > 0, `${String(list.length)} model(s)`)
  for (const m of list) {
    info(m.id, `${m.name} · ${String(Math.round(m.contextWindow / 1000))}k ctx · thinking ${m.efforts.length > 0 ? m.efforts.join('/') : 'none'}${m.group ? ' · routing group' : ''}`)
  }
  if (s.catalogError) info('catalog error', String(s.catalogError))

  // ── 7. profile health: no entry failed to activate this boot ────────────────
  // The regression this guards: the plugin's route used to be the bare `magpie`,
  // which collided with the provider magpie's handover injects into llm-pi-ai.
  // pi-ai's whole fiber failed, the profile degraded, and the models that ride
  // pi-ai disappeared. Read this boot's log slice and fail on any dead entry.
  try {
    const log = fs.readFileSync(ENGINE_LOG, 'utf8')
    const lastBoot = log.lastIndexOf('---- engine start')
    const slice = lastBoot === -1 ? log : log.slice(lastBoot)
    const collision = slice.includes('is already declared')
    const deadEntry = slice.match(/failed=\[([^\]]+)\]/)
    line('no provider-name collision this boot', !collision, collision ? '"is already declared" found in the boot log' : '')
    line('every plugin entry activated', deadEntry === null, deadEntry ? `failed: ${deadEntry[1]}` : 'profile healthy')
    if (deadEntry !== null) info('hint', 'a failed entry means the profile is degraded; find its LlmError above this line in engine.log')
  } catch { line('engine.log readable for health check', false) }

  // ── 8. a real round trip through the plugin's own test route ───────────────
  if (list.length > 0) {
    const target = list.find(m => !m.group) ?? list[0]
    const effort = target.efforts.includes('off') ? 'off' : target.efforts[0]
    process.stdout.write(`\n  driving one real turn through ${target.id} (effort ${effort})…\n`)
    const body = JSON.stringify({ model: target.id, effort })
    const r = await fetch(`${WEB}/api/magpie-model/test`, {
      method: 'POST', headers: { cookie: jar, 'content-type': 'application/json' }, body,
    })
    const result = await r.json().catch(() => null)
    const ok = result?.ok === true
    line('a real turn completed through the gateway', ok, ok ? `${String(result.ms)}ms · ${String(result.reasoningTokens)} reasoning tok · ${JSON.stringify(String(result.reply).slice(0, 40))}` : String(result?.error ?? 'no result'))
  }

  // ── verdict ────────────────────────────────────────────────────────────────
  let bootHealthy = false
  try {
    const log = fs.readFileSync(ENGINE_LOG, 'utf8')
    const slice = log.slice(Math.max(0, log.lastIndexOf('---- engine start')))
    bootHealthy = !slice.includes('is already declared') && !/failed=\[[^\]]+\]/.test(slice)
  } catch { bootHealthy = false }
  const healthy = s.enabled === true && gw.ready === true && list.length > 0 && bootHealthy
  process.stdout.write(`\n${healthy
    ? 'the magpie-model plugin is live: gateway serving, models published, profile healthy.'
    : 'the plugin mounted but is not fully live — read the ✗ lines above.'}\n`)
  process.exit(healthy ? 0 : 2)
}

main().catch(error => {
  process.stdout.write(`\nverification threw: ${String(error?.message ?? error)}\n`)
  process.exit(1)
})
