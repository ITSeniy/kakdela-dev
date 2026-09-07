import Fastify from 'fastify'
import websocket from '@fastify/websocket'

import { createAdmissionGateway } from '../src/media/admission-gateway.js'
import { sql } from '../src/lib/db.js'

if (!process.env.AUDIT_ADMISSION_URL || process.env.NODE_ENV !== 'test')
  throw new Error('disposable test worker only')
const app = Fastify()
await app.register(websocket, { options: { maxPayload: 65536 } })
await app.register(createAdmissionGateway())
await app.listen({ host: '127.0.0.1', port: 0 })
const address = app.server.address()
if (!address || typeof address === 'string') throw new Error('invalid test port')
process.send?.({ port: address.port })
process.on('message', () => {
  void app
    .close()
    .then(() => sql.end())
    .then(() => process.exit(0))
    .catch(() => process.exit(1))
})
