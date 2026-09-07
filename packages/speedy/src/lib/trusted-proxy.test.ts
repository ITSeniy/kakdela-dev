import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { parseTrustedProxy } from './trusted-proxy.js'

describe('explicit proxy trust', () => {
  it('fails closed on blanket trust', () => {
    expect(parseTrustedProxy('auto')).toBe(false)
    expect(parseTrustedProxy('false')).toBe(false)
    for (const value of ['true', '0.0.0.0/0', '::/0', 'example.com', '10.1.1.1,']) {
      expect(() => parseTrustedProxy(value)).toThrow()
    }
  })
  it('distinguishes clients only through the configured proxy and ignores spoofing', async () => {
    const app = Fastify({ trustProxy: parseTrustedProxy('10.2.3.4/32') })
    app.get('/', (req) => ({ ip: req.ip }))
    try {
      const request = async (remoteAddress: string, forwarded: string) => (await app.inject({ url: '/', remoteAddress, headers: { 'x-forwarded-for': forwarded } })).json() as { ip: string }
      expect((await request('10.2.3.4', '198.51.100.1')).ip).toBe('198.51.100.1')
      expect((await request('10.2.3.4', '198.51.100.2')).ip).toBe('198.51.100.2')
      expect((await request('198.51.100.3', '1.1.1.1')).ip).toBe('198.51.100.3')
    } finally { await app.close() }
  })
})
