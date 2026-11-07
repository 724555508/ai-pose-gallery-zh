import { isIP } from 'node:net'
import type { IncomingMessage } from 'node:http'

export function isLocalAddress(value: string): boolean {
  const address = value.toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '').split('%')[0]
  if (address === 'localhost' || address === '::1') return true
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  return isIP(address) === 6 && /^(fc|fd|fe[89ab])/.test(address)
}

export function allowsLocalRequest(req: IncomingMessage, allowReadWithoutOrigin = false): boolean {
  try {
    if (!req.headers.host || !isLocalAddress(req.socket.remoteAddress || '')) return false
    const target = new URL(`http://${req.headers.host}`)
    if (!isLocalAddress(target.hostname) || req.headers['sec-fetch-site'] === 'cross-site') return false
    if (!req.headers.origin) return allowReadWithoutOrigin && req.method === 'GET'
    const origin = new URL(req.headers.origin)
    return origin.origin === target.origin
  } catch { return false }
}
