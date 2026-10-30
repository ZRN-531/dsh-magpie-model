/**
 * The local DNS resolver magpie needs.
 *
 * magpie is a pure-Go binary: `strings` on it shows the runtime refusing
 * `GODEBUG=netdns=cgo` because it was compiled without the cgo resolver, so it
 * never calls bionic's `getaddrinfo` and never reaches netd. It reads
 * `/etc/resolv.conf` instead — and on Android `/etc` is a symlink to
 * `/system/etc`, a read-only erofs with no resolv.conf in it. With no file to
 * read, Go's fallback list is `127.0.0.1:53` and `[::1]:53`, and nothing
 * listens there, so every lookup dies with `connection refused`.
 *
 * That is exactly why the first `magpie web` run on this device logged
 * `catalog: ... lookup models.dev on [::1]:53: read: connection refused` and
 * `partners: ... lookup usemagpie.ai on [::1]:53 ...` while the harness's own
 * node-fetch requests worked fine. The two runtimes resolve names differently.
 *
 * The fix is to be the resolver Go is already looking for: listen on UDP :53
 * (both families) and forward each datagram to a public resolver that this
 * network can actually reach. Binding a privileged port needs root, which the
 * engine has; when it does not, `start` reports the failure and the caller
 * degrades — a magpie that cannot resolve simply shows an empty catalog rather
 * than taking the harness down with it.
 *
 * Upstreams are tried in order with a short per-hop timeout, because on a
 * restricted network the first public resolver may be silently dropped (1.1.1.1
 * measured timing out here while 223.5.5.5 answered in milliseconds).
 *
 * @module src/dns.js
 */

import dgram from 'node:dgram'

/** Public resolvers, most-likely-to-answer-on-a-CN-network first. */
const DEFAULT_UPSTREAMS = [
  { host: '223.5.5.5', port: 53 },
  { host: '119.29.29.29', port: 53 },
  { host: '8.8.8.8', port: 53 },
]

/** Per-upstream wait before falling through to the next one. */
const HOP_TIMEOUT_MS = 3000

/**
 * Start forwarding. Resolves with a handle whether or not every socket bound:
 * one working family is already enough for Go, which tries both.
 *
 * @param {{ upstreams?: Array<{host: string, port: number}>, port?: number, log?: (message: string) => void }} [options]
 * @returns {Promise<{ listening: string[], failed: string[], queries: number, stop: () => void }>}
 */
export async function startLocalResolver(options = {}) {
  const upstreams = Array.isArray(options.upstreams) && options.upstreams.length > 0
    ? options.upstreams
    : DEFAULT_UPSTREAMS
  const port = Number.isInteger(options.port) && options.port > 0 ? options.port : 53
  const log = options.log ?? (() => {})
  const sockets = []
  const listening = []
  const failed = []
  const stats = { queries: 0 }

  /**
   * Forward one query datagram, replying on the socket it arrived at.
   *
   * The reply carries the same transaction id because the query bytes are
   * forwarded verbatim and the upstream echoes the header — no DNS parsing
   * happens here at all, which keeps this correct for record types it has no
   * idea about (AAAA, HTTPS, SVCB).
   */
  const forward = (msg, rinfo, server) => {
    stats.queries += 1
    let settled = false
    let hop = 0

    const send = (buf) => {
      try { server.send(buf, rinfo.port, rinfo.address) } catch { /* client already gone */ }
    }

    const nextHop = () => {
      if (settled || hop >= upstreams.length) return
      const up = upstreams[hop]
      hop += 1
      let sock
      try { sock = dgram.createSocket(up.host.includes(':') ? 'udp6' : 'udp4') } catch { nextHop(); return }
      const timer = setTimeout(() => { close(); nextHop() }, HOP_TIMEOUT_MS)
      const close = () => { clearTimeout(timer); try { sock.close() } catch { /* already closed */ } }
      sock.on('message', (buf) => {
        if (settled) { close(); return }
        settled = true
        send(buf)
        close()
      })
      sock.on('error', () => { close(); if (!settled) nextHop() })
      try {
        sock.send(msg, 0, msg.length, up.port, up.host, (error) => {
          if (error !== undefined && error !== null) { close(); if (!settled) nextHop() }
        })
      } catch { close(); if (!settled) nextHop() }
    }
    nextHop()
  }

  const bind = (type, address) => new Promise((resolve) => {
    let sock
    try { sock = dgram.createSocket({ type, reuseAddr: true }) } catch (error) {
      failed.push(`${address} (${error.message})`)
      resolve()
      return
    }
    const done = (outcome) => { try { sock.unref?.() } catch { /* keep-alive is best effort */ } resolve(outcome) }
    sock.on('message', (msg, rinfo) => forward(msg, rinfo, sock))
    sock.on('error', (error) => {
      if (!listening.includes(`${address}:${port}`)) failed.push(`${address}:${port} (${error.code ?? error.message})`)
      else log(`dns: ${address}:${port} failed after binding: ${error.message}`)
    })
    try {
      sock.bind(port, address, () => {
        listening.push(`${address}:${port}`)
        sockets.push(sock)
        done()
      })
    } catch (error) {
      failed.push(`${address}:${port} (${error.message})`)
      done()
    }
  })

  await bind('udp4', '127.0.0.1')
  await bind('udp6', '::1')

  if (listening.length > 0) log(`dns: forwarding ${listening.join(', ')} -> ${upstreams.map(u => u.host).join(', ')}`)
  else log(`dns: could not bind :${port} (${failed.join('; ')}); magpie will resolve nothing`)

  return {
    listening,
    failed,
    get queries() { return stats.queries },
    stop() {
      for (const sock of sockets.splice(0)) { try { sock.close() } catch { /* already closed */ } }
      listening.length = 0
    },
  }
}
