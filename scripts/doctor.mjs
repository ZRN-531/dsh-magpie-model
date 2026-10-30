#!/usr/bin/env node
/**
 * doctor — verify this plugin is installed and loaded correctly, and repair the
 * things an app/engine update can silently break.
 *
 * A dsh Mobile app update reinstalls the engine directory but keeps the user data
 * under `$DSH_HOME`. Everything this plugin needs is deliberately under
 * `$DSH_HOME` (source, the magpie binary, accounts, settings, the profile
 * registration), so an update normally leaves it working. But two edges are worth
 * checking after every update, because their failure is **silent** — the plugin
 * simply does not load and the model picker shows no Magpie group, with the only
 * evidence buried in the engine log:
 *
 *   1. the profile's `dsh.profile.bundles` no longer lists `dsh-magpie-model`
 *      (a template rewrite during a major upgrade), and
 *   2. the profile's `node_modules/dsh-magpie-model` symlink is gone or dangling
 *      (node_modules rebuilt, or an offline install that failed).
 *
 * This script checks both, repairs them in place (with a backup), and then runs a
 * live check against the running engine to prove the plugin is actually serving.
 *
 * Usage:
 *   node scripts/doctor.mjs            check, repair structural problems, live-check
 *   node scripts/doctor.mjs --check    check only; change nothing
 *   node scripts/doctor.mjs --no-live  skip the live engine check
 *   node scripts/doctor.mjs --json     machine-readable summary on stdout
 *
 * Exit code: 0 healthy (or repaired to healthy), 1 an unresolved problem remains.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ARGS = new Set(process.argv.slice(2))
const FIX = !ARGS.has('--check')
const LIVE = !ARGS.has('--no-live')
const JSON_OUT = ARGS.has('--json')

const PLUGIN_NAME = 'dsh-magpie-model'
// The plugin registers its JSON API under the provider route name, which has no
// `dsh-` prefix: package = dsh-magpie-model, API = /api/magpie-model. Conflating
// the two made the live check call /api/dsh-magpie-model and read 404 as "not
// loaded" while the plugin was actually serving fine.
const API_ROUTE = 'magpie-model'
const findings = [] // { level: 'ok'|'fixed'|'warn'|'fail', code, detail }
const record = (level, code, detail) => { findings.push({ level, code, detail }); if (!JSON_OUT) print(level, code, detail) }

function icon(level) {
  return level === 'ok' ? '✓' : level === 'fixed' ? '✚' : level === 'warn' ? '⚠' : '✗'
}
function print(level, code, detail) {
  process.stdout.write(`${icon(level)} [${code}] ${detail}\n`)
}
function section(title) { if (!JSON_OUT) process.stdout.write(`\n${title}\n`) }

const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : path.join(os.homedir(), '.dsh')
const prefix = process.env.PREFIX && process.env.PREFIX.trim() !== '' ? process.env.PREFIX.trim() : ''
const profileName = process.env.DSH_PROFILE && process.env.DSH_PROFILE.trim() !== '' ? process.env.DSH_PROFILE.trim() : 'web'
const profileDir = path.join(home, 'profiles', profileName)
const profilePkg = path.join(profileDir, 'package.json')

// ── 1. the plugin source (under $DSH_HOME — survives app updates) ──────────────
section('plugin source')
let pluginDir = path.join(home, 'plugins', PLUGIN_NAME)
// Prefer the directory the running profile actually resolves to, so a relocated
// install is diagnosed where it really is, not guessed.
const linkInProfile = path.join(profileDir, 'node_modules', PLUGIN_NAME)
try {
  const real = fs.realpathSync(linkInProfile)
  pluginDir = real
} catch { /* not linked yet; fall back to the conventional location */ }

let pluginOk = false
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
  pluginOk = pkg.name === PLUGIN_NAME && pkg.dsh?.bundle !== undefined
  record(pluginOk ? 'ok' : 'fail', 'source', pluginOk
    ? `${pluginDir}  (v${pkg.version})`
    : `${pluginDir}/package.json is not a ${PLUGIN_NAME} bundle`)
} catch (error) {
  record('fail', 'source', `cannot read ${pluginDir}/package.json — ${error.message}`)
}
if (!pluginOk) {
  record('fail', 'source-missing', `re-clone the plugin into ${pluginDir} (git clone https://github.com/ZRN-531/dsh-magpie-model) — cannot repair from nothing`)
}

// ── 2. the magpie binary (also under $DSH_HOME — the engine dir is wiped) ──────
section('magpie binary')
const binCandidates = [
  path.join(home, '.local', 'bin', 'magpie'),
  ...(prefix !== '' ? [path.join(prefix, 'bin', 'magpie')] : []),
]
let binOk = false
let binPath = ''
for (const candidate of binCandidates) {
  if (fs.existsSync(candidate)) { binPath = candidate; binOk = true; break }
}
if (binOk) {
  record('ok', 'binary', binPath)
  // A fresh binary that does not execute is worse than a missing one; make it say so.
  try {
    const { spawnSync } = await import('node:child_process')
    const probe = spawnSync(binPath, ['--version'], { encoding: 'utf8', timeout: 15000 })
    record(probe.status === 0 ? 'ok' : 'warn', 'binary-run', probe.status === 0
      ? String(probe.stdout ?? '').trim()
      : `${binPath} did not run: ${String(probe.stderr ?? probe.stdout ?? '').trim().slice(0, 120)}`)
  } catch (error) { record('warn', 'binary-run', `${binPath} could not be executed: ${error.message}`) }
} else {
  record('warn', 'binary', 'magpie not found under $DSH_HOME/.local/bin — installing it needs network: run')
  record('warn', 'binary-cmd', `  TERMUX_VERSION=1 MAGPIE_MIRROR=https://ghfast.top/ MAGPIE_BIN_DIR="$DSH_HOME/.local/bin" sh -c "$(curl -fsSL https://usemagpie.ai/install.sh)"`)
}

// ── 3. the accounts (magpie's own config — a sign-in loss is a data loss) ───────
section('magpie accounts')
const providersFile = path.join(home, '.config', 'magpie', 'providers.json')
if (fs.existsSync(providersFile)) record('ok', 'accounts', providersFile)
else record('warn', 'accounts', `no ${providersFile} — magpie has no signed-in channel yet (open the web console to sign in)`)

// ── 4. profile registration (the silent-failure edge) ─────────────────────────
section('profile registration')
let profileManifest = null
try {
  profileManifest = JSON.parse(fs.readFileSync(profilePkg, 'utf8'))
} catch (error) {
  record('fail', 'profile-pkg', `cannot read ${profilePkg} — ${error.message}`)
}

if (profileManifest !== null) {
  const rel = path.relative(profileDir, pluginDir) // e.g. ../../plugins/dsh-magpie-model
  const spec = `link:${rel.split(path.sep).join('/')}`
  const deps = profileManifest.dependencies ?? {}
  const bundles = profileManifest.dsh?.profile?.bundles ?? []

  const depOk = typeof deps[PLUGIN_NAME] === 'string'
  const bundleOk = bundles.includes(PLUGIN_NAME)

  if (depOk) record('ok', 'dep', `dependencies["${PLUGIN_NAME}"] = ${deps[PLUGIN_NAME]}`)
  else if (FIX && pluginOk) {
    profileManifest.dependencies = { ...deps, [PLUGIN_NAME]: spec }
    record('fixed', 'dep', `added dependencies["${PLUGIN_NAME}"] = ${spec}`)
  } else record('warn', 'dep', `dependencies["${PLUGIN_NAME}"] is missing${FIX ? '' : ' (run without --check to add it)'}`)

  if (bundleOk) record('ok', 'bundle', `dsh.profile.bundles includes "${PLUGIN_NAME}"`)
  else if (FIX && pluginOk) {
    profileManifest.dsh ??= {}
    profileManifest.dsh.profile ??= {}
    profileManifest.dsh.profile.bundles = [...bundles, PLUGIN_NAME]
    record('fixed', 'bundle', `added "${PLUGIN_NAME}" to dsh.profile.bundles`)
  } else record('warn', 'bundle', `"${PLUGIN_NAME}" is not in dsh.profile.bundles${FIX ? '' : ' (run without --check to add it)'}`)

  // Write the manifest once if either repair touched it, with a timestamped backup.
  if (FIX && (!depOk || !bundleOk) && pluginOk) {
    try {
      const backup = `${profilePkg}.bak-${Date.now()}`
      fs.copyFileSync(profilePkg, backup)
      fs.writeFileSync(profilePkg, JSON.stringify(profileManifest, null, 2) + '\n')
      record('fixed', 'profile-write', `wrote ${profilePkg} (backup: ${path.basename(backup)})`)
    } catch (error) { record('fail', 'profile-write', `could not write ${profilePkg}: ${error.message}`) }
  }
}

// ── 5. the profile symlink (the other silent-failure edge) ────────────────────
section('profile symlink')
let linkState = 'missing'
let linkTarget = ''
try {
  linkTarget = fs.readlinkSync(linkInProfile)
  // A dangling link resolves too (to a path that may not exist) — check it points
  // at our plugin and that the target actually has a package.json.
  const resolved = fs.realpathSync(linkInProfile)
  linkState = resolved === fs.realpathSync(pluginDir) ? 'ok' : 'wrong'
  linkTarget = resolved
} catch { linkState = fs.existsSync(linkInProfile) ? 'wrong' : 'missing' }

if (linkState === 'ok') {
  record('ok', 'symlink', `${linkInProfile} -> ${linkTarget}`)
} else if (FIX && pluginOk) {
  try {
    fs.mkdirSync(path.dirname(linkInProfile), { recursive: true })
    try { fs.rmSync(linkInProfile, { recursive: true, force: true }) } catch { /* not there */ }
    fs.symlinkSync(pluginDir, linkInProfile)
    record('fixed', 'symlink', (linkState === 'missing' ? 'created' : 'repaired') + ` ${linkInProfile} -> ${pluginDir}`)
  } catch (error) { record('fail', 'symlink', `could not create ${linkInProfile}: ${error.message}`) }
} else {
  record('warn', 'symlink', `${linkInProfile} is ${linkState}${FIX ? '' : ' (run without --check to fix)'}`)
}

// ── 6. live check: is the plugin actually loaded and serving? ─────────────────
if (LIVE) {
  section('live check')
  await liveCheck()
}

async function liveCheck() {
  const engineLog = prefix !== '' ? path.join(prefix, 'engine.log') : ''
  const web = 'http://127.0.0.1:3080'
  const tail = (s, n) => String(s).slice(-n)
  const token = (() => {
    try {
      const text = fs.readFileSync(engineLog, 'utf8')
      const m = [...text.matchAll(/token=([A-Za-z0-9_-]+)/g)]
      return m.length ? m[m.length - 1][1] : null
    } catch { return null }
  })()

  let up = false
  try { await fetch(`${web}/api/${API_ROUTE}/status`); up = true } catch { up = false }
  if (!up) { record('warn', 'engine', `engine is not answering on ${web} — start it, then re-run`); return }
  record('ok', 'engine', `${web} is up`)
  if (token === null) { record('warn', 'token', 'no launch token in engine.log — cannot run the authenticated check'); return }

  let jar = ''
  try {
    const c = await fetch(`${web}/connect?token=${token}`, { redirect: 'manual' })
    jar = (c.headers.getSetCookie ? c.headers.getSetCookie() : []).map(x => x.split(';')[0]).join('; ')
  } catch { /* handled below */ }
  if (jar === '') { record('warn', 'auth', 'the /connect handshake failed — cannot verify the authenticated routes'); return }

  const get = async (route) => {
    const r = await fetch(`${web}${route}`, { headers: { cookie: jar } })
    return { status: r.status, body: await r.json().catch(() => null) }
  }

  const status = await get(`/api/${API_ROUTE}/status`)
  if (status.status !== 200) {
    record('fail', 'loaded', `plugin API is ${status.status} — the bundle did not load; check engine.log for "cannot resolve profile bundle" / a failed entry`)
    return
  }
  record('ok', 'loaded', `plugin loaded (v${status.body?.version})`)
  const gw = status.body?.gateway ?? {}
  record(gw.ready === true ? 'ok' : 'warn', 'gateway', gw.ready === true
    ? `running (${gw.mode} @ ${gw.addr})`
    : `not ready (mode ${String(gw.mode)})`)

  const models = await get(`/api/${API_ROUTE}/models`)
  const count = Array.isArray(models.body?.models) ? models.body.models.length : 0
  record(count > 0 ? 'ok' : 'warn', 'models', `${count} model(s) synced`)

  // A single real round trip proves the whole chain, not just that the API answers.
  if (count > 0) {
    const target = (models.body.models.find(m => !m.group) ?? models.body.models[0])
    const effort = Array.isArray(target.efforts) && target.efforts.includes('off') ? 'off' : (target.efforts?.[0])
    try {
      const r = await fetch(`${web}/api/${API_ROUTE}/test`, {
        method: 'POST', headers: { cookie: jar, 'content-type': 'application/json' },
        body: JSON.stringify(effort ? { model: target.id, effort } : { model: target.id }),
      })
      const result = await r.json().catch(() => null)
      record(result?.ok === true ? 'ok' : 'warn', 'turn', result?.ok === true
        ? `${target.id}: ${String(result.ms)}ms, ${String(result.reasoningTokens ?? 0)} reasoning tok`
        : `${target.id}: ${String(result?.error ?? 'no result')}`)
    } catch (error) { record('warn', 'turn', `test call failed: ${error.message}`) }
  }
}

// ── verdict ───────────────────────────────────────────────────────────────────
const fails = findings.filter(f => f.level === 'fail')
const warns = findings.filter(f => f.level === 'warn')
const fixed = findings.filter(f => f.level === 'fixed')
const healthy = fails.length === 0

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ healthy, findings, fixedCount: fixed.length, warnCount: warns.length, failCount: fails.length }, null, 2) + '\n')
} else {
  process.stdout.write('\n')
  if (!healthy) process.stdout.write(`✗ ${fails.length} problem(s) remain, ${warns.length} warning(s)\n`)
  else if (warns.length > 0) process.stdout.write(`⚠ healthy with ${warns.length} warning(s)${fixed.length ? `, ${fixed.length} fixed` : ''}\n`)
  else process.stdout.write(`✓ all good${fixed.length ? ` (${fixed.length} repaired)` : ''}\n`)
}
process.exit(healthy ? 0 : 1)
