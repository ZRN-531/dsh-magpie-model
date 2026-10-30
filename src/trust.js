/**
 * The connection admission fence, read defensively.
 *
 * The harness publishes a `connection` service that decides whether a request
 * may be served at all — it is what keeps a LAN-exposed WebUI from handing an
 * unauthenticated caller this plugin's settings API. Two spellings of the same
 * decision are installed in the field:
 *
 * - hosts from dsh 0.1.7 on expose `admit(req)`, returning an `{ rejection }`
 *   envelope;
 * - older hosts expose `requestRejection(req)`, returning a bare status.
 *
 * Reading only the newer name turned *every* request into `503 admission
 * unavailable` on an older host, because the service existed but the method did
 * not — so an absent `admit` must fall through to `requestRejection`, and only a
 * composition that publishes neither is treated as unfenced.
 *
 * The composition may publish `connection` long after plugins load, so this is
 * read per request rather than captured once.
 *
 * @module src/trust.js
 */

/**
 * The fence's decision for one request, or `undefined` to serve it.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ admit?: (req: unknown) => unknown, requestRejection?: (req: unknown) => unknown } | undefined} connection
 * @param {(detail: { status: number, reason: string }) => void} [onRejection]
 * @returns {number | undefined} an HTTP status to answer with, or undefined to serve
 */
export function rejectionFor(req, connection, onRejection) {
  let decision
  try {
    const admit = connection?.admit
    if (typeof admit === 'function') {
      const admission = admit.call(connection, req)
      const status = admission !== null && typeof admission === 'object' ? admission.rejection : undefined
      if (status === undefined) return undefined
      decision = { status: Number(status), reason: 'host-rejected' }
    } else {
      const reject = connection?.requestRejection
      if (typeof reject === 'function') {
        const status = reject.call(connection, req)
        if (status === undefined || status === null) return undefined
        decision = { status: Number(status), reason: 'host-rejected' }
      }
    }
  } catch {
    // A fence that throws cannot be trusted either way. Serving would bypass a
    // host that meant to refuse; refusing would break a host whose fence is
    // simply not built for this request shape. Refuse, and say so: 503 tells the
    // page "admission unavailable" rather than "you are not allowed", which is
    // the honest reading of a broken fence.
    decision = { status: 503, reason: 'admission-error' }
  }
  if (decision === undefined) return undefined
  const status = Number.isFinite(decision.status) && decision.status >= 400 ? decision.status : 403
  onRejection?.({ status, reason: decision.reason })
  return status
}
