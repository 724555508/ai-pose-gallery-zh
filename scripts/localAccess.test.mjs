import test from 'node:test'
import assert from 'node:assert/strict'
import { allowsLocalRequest, isLocalAddress } from './localAccess.ts'

test('local and private LAN addresses are allowed, public addresses are rejected', () => {
  for (const value of ['localhost', '127.0.0.1', '::1', '::ffff:192.168.1.20', '10.0.0.2', '172.16.0.3', '172.31.1.2', '192.168.1.20', '[fd00::1]', 'fe80::1%12']) assert.equal(isLocalAddress(value), true, value)
  for (const value of ['8.8.8.8', '172.15.1.1', '172.32.1.1', '192.169.1.1', '0.0.0.0', 'example.com', '2001:4860:4860::8888']) assert.equal(isLocalAddress(value), false, value)
})
test('LAN writes require the same origin; public peers and cross-site requests are denied', () => {
  const request = { method: 'POST', socket: { remoteAddress: '192.168.1.20' }, headers: { host: '192.168.1.10:5173', origin: 'http://192.168.1.10:5173' } }
  assert.equal(allowsLocalRequest(request), true)
  assert.equal(allowsLocalRequest({ ...request, headers: { ...request.headers, origin: 'http://evil.example' } }), false)
  assert.equal(allowsLocalRequest({ ...request, headers: { ...request.headers, origin: 'https://192.168.1.10:5173' } }), false)
  assert.equal(allowsLocalRequest({ ...request, socket: { remoteAddress: '8.8.8.8' } }), false)
  assert.equal(allowsLocalRequest({ ...request, headers: { host: '192.168.1.10:5173' } }), false)
  assert.equal(allowsLocalRequest({ ...request, method: 'GET', headers: { host: '192.168.1.10:5173' } }, true), true)
  assert.equal(allowsLocalRequest({ ...request, headers: { ...request.headers, 'sec-fetch-site': 'cross-site' } }), false)
})
