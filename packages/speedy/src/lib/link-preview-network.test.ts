import http from 'node:http'
import { describe, expect, it, vi } from 'vitest'
vi.mock('./redis.js', () => ({ redis: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK') } }))
import { fetchLinkPreview } from './link-preview.js'

describe('SSRF network boundary', () => {
  it('never connects to a real loopback listener using alternative URL forms', async () => {
    let hits = 0
    const server = http.createServer((_req, res) => { hits++; res.end('<title>private</title>') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      await fetch('http://' + '127.0.0.1:' + port + '/control')
      expect(hits).toBe(1)
      hits = 0
      for (const host of ['127.0.0.1', '127.1', '2130706433', '0x7f000001', '0177.0.0.1', '[::ffff:7f00:1]']) {
        const url = 'http://' + host + ':' + port + '/private'
        expect(new URL(url).port).toBe(String(port))
        expect(await fetchLinkPreview(url)).toBeNull()
      }
      expect(hits).toBe(0)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
    }
  })
})
