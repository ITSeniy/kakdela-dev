import { Writable } from 'node:stream'

import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import { installSafeNotFound, makeLoggerOptions, safeRequestUrl } from './logger.js'

describe('credential-safe HTTP logging', () => {
  it('removes every query key without depending on its spelling', () => {
    expect(safeRequestUrl('/livekit/rtc?%61ccess_token=secret&x=secret')).toBe('/livekit/rtc')
    expect(safeRequestUrl(undefined)).toBeUndefined()
  })
  it('does not leak tokens in request or default 404 messages', async () => {
    let output = ''
    const stream = new Writable({
      write(chunk, _encoding, done) {
        output += chunk.toString()
        done()
      },
    })
    const options = makeLoggerOptions()
    if (!options || typeof options !== 'object') throw new Error('missing logger configuration')
    const app = Fastify({ logger: { ...options, level: 'info', stream } })
    installSafeNotFound(app)
    app.get('/ok', async () => 'ok')
    try {
      for (const path of ['/ok', '/livekit/rtc/v1/validate', '/unknown']) {
        await app.inject({
          url: path + '?%61ccess_token=NEVER_LOG_THIS',
          headers: { authorization: 'Bearer NEVER_LOG_HEADER', cookie: 'x=NEVER_LOG_COOKIE' },
        })
      }
      expect(output).toContain('request completed')
      expect(output).not.toContain('NEVER_LOG')
      expect(output).not.toContain('access_token')
    } finally {
      await app.close()
    }
  })
})
