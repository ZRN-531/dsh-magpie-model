/**
 * magpie binary self-updater.
 *
 * The plugin's job is to keep magpie alive and drive it; it also owns keeping
 * magpie *current*, because a plugin that supervises an old gateway while a new
 * one is published is silently serving yesterday's providers. This module checks
 * the official release feed, downloads the Android build, verifies its SHA-256
 * against the feed (never from the download), and atomically replaces the binary.
 *
 * Safety decisions that matter:
 *
 * - **Check first, download once, verify before replacing.** The feed is the only
 *   trusted source for the hash; a tampered mirror is refused. The binary is only
 *   moved into place after the checksum matches, so a half-download or a
 *   corrupted transfer never replaces a working gateway.
 * - **Atomic publish.** Android's SELinux denies `link()`, so the only atomic
 *   publish available is write-temp + `rename()`. A crash mid-write otherwise
 *   leaves a truncated binary where a working one was.
 * - **No auto-restart.** The caller decides when to restart the supervised
 *   gateway; this module only reports "a new version is installed". Restarting a
 *   gateway with in-flight turns is the supervisor's call, not the downloader's.
 * - **Retryable and bounded.** Every network fetch has a timeout; a dead feed or
 *   a dead CDN fails cleanly instead of hanging the catalog refresh loop.
 *
 * @module src/update.js
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** The official feed. It is always fetched directly — never through a mirror. */
export const UPDATE_FEED = 'https://usemagpie.ai/api/latest'

/** The asset key for this platform (Android/Termux build). */
export const ANDROID_ASSET = 'magpie-cli-android-arm64'

/** Network timeouts, kept short so a dead upstream cannot hang startup. */
const FEED_TIMEOUT_MS = 15000
const DOWNLOAD_TIMEOUT_MS = 300000

/**
 * Parse the current binary's version into [major, minor, patch].
 * @param {string} version - e.g. "magpie 0.1.2434" or "0.1.2434"
 * @returns {[number, number, number]} sorted-comparable triple
 */
export function parseVersion(version) {
  const raw = String(version ?? '').trim().replace(/^magpie\s*/i, '')
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (match === null) return [0, 0, 0]
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Is `a` a newer release than `b`?
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isNewer(a, b) {
  const [a0, a1, a2] = parseVersion(a)
  const [b0, b1, b2] = parseVersion(b)
  return a0 > b0 || (a0 === b0 && (a1 > b1 || (a1 === b1 && a2 > b2)))
}

/**
 * Read the official release feed.
 *
 * @param {object} [options]
 * @param {string} [options.feed] - feed URL; defaults to {@link UPDATE_FEED}
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl] - injectable for tests
 * @returns {Promise<{ ok: true, version: string, asset: { url: string, sha256: string, size: number } } | { ok: false, error: string }>}
 */
export async function checkLatest(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? FEED_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('feed timed out')), timeoutMs)
  if (options.signal !== undefined) {
    if (options.signal.aborted === true) controller.abort(options.signal.reason)
    else options.signal.addEventListener('abort', () => controller.abort(options.signal.reason), { once: true })
  }
  try {
    const response = await fetchImpl(options.feed ?? UPDATE_FEED, { signal: controller.signal })
    if (!response.ok) return { ok: false, error: `the update feed answered ${String(response.status)}` }
    const body = await response.json()
    const version = typeof body?.version === 'string' ? body.version : ''
    const asset = body?.assets?.[ANDROID_ASSET]
    if (version === '' || asset === undefined) return { ok: false, error: 'the update feed has no version or android asset' }
    const sha256 = typeof asset.sha256 === 'string' ? asset.sha256 : ''
    const url = typeof asset.url === 'string' ? asset.url : ''
    if (sha256.length !== 64 || url === '') return { ok: false, error: 'the update feed has a malformed android asset' }
    return { ok: true, version, asset: { url, sha256, size: Number(asset.size) || 0 } }
  } catch (error) {
    const cause = typeof error?.cause?.message === 'string' ? ` — ${error.cause.message}` : ''
    return { ok: false, error: `could not read the update feed: ${error.message}${cause}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Download a URL and verify its SHA-256.
 *
 * @param {string} url
 * @param {string} expectedSha256 - 64 hex chars from the feed
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ ok: true, data: Buffer } | { ok: false, error: string }>}
 */
export async function downloadAndVerify(url, expectedSha256, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('download timed out')), timeoutMs)
  if (options.signal !== undefined) {
    if (options.signal.aborted === true) controller.abort(options.signal.reason)
    else options.signal.addEventListener('abort', () => controller.abort(options.signal.reason), { once: true })
  }
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    if (!response.ok) return { ok: false, error: `the download answered ${String(response.status)}` }
    const data = Buffer.from(await response.arrayBuffer())
    const got = crypto.createHash('sha256').update(data).digest('hex')
    if (got !== expectedSha256) return { ok: false, error: `the download does not match its checksum (expected ${expectedSha256.slice(0, 12)}…, got ${got.slice(0, 12)}…); nothing was installed` }
    return { ok: true, data }
  } catch (error) {
    const cause = typeof error?.cause?.message === 'string' ? ` — ${error.cause.message}` : ''
    return { ok: false, error: `the download failed: ${error.message}${cause}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Atomically replace the binary at `target` with `data`, preserving mode 0755.
 *
 * @param {string} target - absolute path of the current binary
 * @param {Buffer} data - the verified new binary
 * @returns {{ ok: true, backup?: string } | { ok: false, error: string }}
 */
export function installBinary(target, data) {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temp = `${target}.update-${process.pid}.tmp`
    fs.writeFileSync(temp, data, { mode: 0o755 })
    fs.chmodSync(temp, 0o755)
    fs.renameSync(temp, target)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `could not replace ${target}: ${error.message}` }
  }
}

/**
 * One update pass: check the feed, compare versions, download + verify + install
 * when newer. Returns enough for the caller to decide whether to restart the
 * supervised gateway.
 *
 * @param {object} deps
 * @param {() => { command: string, version: string }} deps.current - the running binary
 * @param {object} [options] - passed to checkLatest/downloadAndVerify
 * @returns {Promise<{ action: 'up-to-date', version: string } | { action: 'updated', from: string, to: string, command: string } | { action: 'error', error: string }>}
 */
export async function updateMagpie(deps, options = {}) {
  const current = deps.current()
  const feed = await checkLatest(options)
  if (!feed.ok) return { action: 'error', error: feed.error }
  if (!isNewer(feed.version, current.version)) return { action: 'up-to-date', version: current.version }
  const downloaded = await downloadAndVerify(feed.asset.url, feed.asset.sha256, options)
  if (!downloaded.ok) return { action: 'error', error: downloaded.error }
  const installed = installBinary(current.command, downloaded.data)
  if (!installed.ok) return { action: 'error', error: installed.error }
  return { action: 'updated', from: current.version, to: feed.version, command: current.command }
}
