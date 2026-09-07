import {
  SignalResponse,
  ClientConfiguration,
  ClientConfigSetting,
  LeaveRequest,
  LeaveRequest_Action,
  DisconnectReason,
} from '@livekit/protocol'
import type { FastifyPluginAsync } from 'fastify'
import { WebSocket, type RawData } from 'ws'

import { env } from '../env.js'
import { AdmissionDenied, withMediaAccess } from './admission-access.js'
import { createBootstrapToken, elevateParticipant } from './admission-sfu.js'
import {
  signAdmission,
  verifyAdmissionToken,
  verifySfuToken,
  type Admission,
} from './admission-token.js'

const MAX_BYTES = 1024 * 1024
const MAX_FRAMES = 128
const HANDSHAKE_TIMEOUT_MS = 8000
const PUBLIC_PATH = '/livekit/rtc'
const QUERY_KEYS = new Set([
  'protocol',
  'client_protocol',
  'capabilities',
  'sdk',
  'version',
  'auto_subscribe',
  'adaptive_stream',
  'disable_ice_lite',
  'subscriber_allow_pause',
  'os',
  'os_version',
  'device_model',
  'browser',
  'browser_version',
  'network',
])

interface ActiveAdmission {
  userId?: string
  serverId?: string | null
  close: () => void
}
const activeAdmissions = new Set<ActiveAdmission>()

export function revokeMediaAdmissions(userId: string, serverId: string): void {
  for (const active of activeAdmissions) {
    if (active.userId === userId && active.serverId === serverId) active.close()
  }
}

function bytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

function parameters(rawUrl: string): URLSearchParams {
  if (rawUrl.length > 24576) throw new Error('invalid signaling request')
  const url = new URL(rawUrl, 'http://gateway.invalid')
  if (![PUBLIC_PATH, PUBLIC_PATH + '/validate'].includes(url.pathname))
    throw new Error('invalid signaling path')
  const p = url.searchParams
  for (const key of p.keys()) {
    if (p.getAll(key).length !== 1) throw new Error('ambiguous signaling query')
    if (
      !QUERY_KEYS.has(key) &&
      !['access_token', 'reconnect', 'sid', 'reconnect_reason'].includes(key)
    )
      throw new Error('unsupported signaling query')
  }
  return p
}

function requestToken(p: URLSearchParams, authorization: string | undefined): string {
  const query = p.get('access_token')
  if (authorization !== undefined) {
    if (query !== null) throw new Error('ambiguous admission credentials')
    const match = /^Bearer ([^\s,]+)$/i.exec(authorization)
    if (!match?.[1]) throw new Error('invalid authorization header')
    return match[1]
  }
  if (!query) throw new Error('missing admission token')
  return query
}

function upstreamUrl(p: URLSearchParams, token: string): string {
  // Destination is fixed by trusted configuration, never a client URL/header.
  const upstream = new URL(env.LIVEKIT_ADMIN_URL ?? 'http://127.0.0.1:7880')
  upstream.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:'
  upstream.pathname = upstream.pathname.replace(/\/$/, '') + '/rtc'
  upstream.search = ''
  for (const key of QUERY_KEYS) {
    const value = p.get(key)
    if (value !== null && value.length <= 256) upstream.searchParams.set(key, value)
  }
  upstream.searchParams.set('access_token', token)
  // Always a fresh participant/DTLS transport. Never forward resume/sid/publish/join_request.
  upstream.searchParams.set('reconnect', '0')
  return upstream.toString()
}

/** Dependency injection is only for deterministic tests; production uses these implementations. */
export interface GatewayDependencies {
  access: typeof withMediaAccess
  bootstrap: typeof createBootstrapToken
  elevate: typeof elevateParticipant
}
const DEFAULT_DEPENDENCIES: GatewayDependencies = {
  access: withMediaAccess,
  bootstrap: createBootstrapToken,
  elevate: elevateParticipant,
}

/** Register inside the scope that already installed @fastify/websocket. */
export function createAdmissionGateway(
  deps: GatewayDependencies = DEFAULT_DEPENDENCIES,
): FastifyPluginAsync {
  return async (app) => {
    const connections = new Set<ActiveAdmission>()
    const perIp = new Map<string, number>()
    app.addHook('onClose', async () => {
      for (const connection of connections) connection.close()
    })

    app.get(PUBLIC_PATH + '/validate', { logLevel: 'silent' }, async (req, reply) => {
      let admission: Admission
      reply.header('cache-control', 'no-store')
      try {
        admission = await verifyAdmissionToken(
          requestToken(parameters(req.url), req.headers.authorization),
        )
      } catch {
        return reply.code(401).send('invalid admission token or signaling parameters')
      }
      try {
        await deps.access(admission, async () => undefined)
        return reply.header('cache-control', 'no-store').code(200).send('success')
      } catch (err) {
        return reply
          .code(err instanceof AdmissionDenied ? 403 : 503)
          .send('media access unavailable')
      }
    })

    // Unsupported v1/other routes deliberately fall back to Fastify's 404. No proxy fallback.
    app.get(PUBLIC_PATH, { websocket: true, logLevel: 'silent' }, (client, req) => {
      if (connections.size >= 64 || (perIp.get(req.ip) ?? 0) >= 12) {
        client.close(4429, 'admission-limit')
        return
      }
      perIp.set(req.ip, (perIp.get(req.ip) ?? 0) + 1)
      let upstream: WebSocket | undefined
      let admission: Admission | undefined
      let closed = false
      let admitted = false
      let queuedBytes = 0
      let pendingServerFrames = 0
      let pendingServerBytes = 0
      let serverTail = Promise.resolve()
      const pendingClient: { data: Buffer; binary: boolean }[] = []
      const context: ActiveAdmission = { close: () => close(4001, 'membership-changed') }
      connections.add(context)
      activeAdmissions.add(context)
      const timer = setTimeout(() => close(4408, 'admission-timeout'), HANDSHAKE_TIMEOUT_MS)
      timer.unref()

      function close(code = 1000, reason = 'closed'): void {
        if (closed) return
        closed = true
        clearTimeout(timer)
        pendingClient.length = 0
        connections.delete(context)
        activeAdmissions.delete(context)
        perIp.set(req.ip, Math.max(0, (perIp.get(req.ip) ?? 1) - 1))
        if (perIp.get(req.ip) === 0) perIp.delete(req.ip)
        // Never remove by identity here: a newer full reconnect may already own that identity.
        // An unadmitted orphan has no negotiated transport. Kick removes participants via SFU RPC.
        upstream?.terminate()
        try {
          client.close(code, reason)
        } catch {
          client.terminate()
        }
      }
      function live(): boolean {
        return !closed && client.readyState === WebSocket.OPEN
      }
      function send(socket: WebSocket, data: Buffer, binary: boolean): void {
        if (!live() || socket.readyState !== WebSocket.OPEN) return
        if (socket.bufferedAmount + data.length > MAX_BYTES) {
          close(4429, 'signaling-backpressure')
          return
        }
        socket.send(data, { binary })
      }
      function fail(err: unknown): void {
        // Do not log raw request URLs, JWTs, SDK errors or upstream error bodies.
        const denied = err instanceof AdmissionDenied
        if (!denied) app.log.warn({ stage: 'media-admission' }, 'media admission failed closed')
        close(denied ? 4403 : 1011, denied ? 'media-access-denied' : 'media-admission-failed')
      }

      client.on('close', () => close())
      client.on('error', () => close(1011, 'client-error'))
      client.on('message', (raw, binary) => {
        const data = bytes(raw)
        if (data.length > MAX_BYTES) {
          close(1009, 'signaling-too-large')
          return
        }
        if (!admitted) {
          queuedBytes += data.length
          if (pendingClient.length >= MAX_FRAMES || queuedBytes > MAX_BYTES) {
            close(4429, 'admission-buffer-full')
            return
          }
          pendingClient.push({ data, binary })
        } else if (upstream) send(upstream, data, binary)
      })

      async function processServerFrame(data: Buffer, binary: boolean): Promise<void> {
        if (!live() || !admission) return
        const response = binary
          ? SignalResponse.fromBinary(data)
          : SignalResponse.fromJsonString(data.toString('utf8'))
        if (!admitted) {
          if (response.message.case !== 'join') throw new Error('expected bootstrap join')
          const join = response.message.value
          const initial = join.participant
          if (
            !initial ||
            initial.identity !== admission.identity ||
            join.room?.name !== admission.room ||
            !initial.permission ||
            initial.permission.canPublish ||
            initial.permission.canSubscribe ||
            initial.permission.canPublishData
          ) {
            throw new Error('invalid bootstrap permissions')
          }
          const ticket = admission
          // No client/SDP frames are forwarded until BOTH elevation and DB commit succeed.
          // If a timed-out RPC is applied later, that orphan still has no usable transport.
          const permitted = await deps.access(ticket, async () => {
            if (!live()) throw new AdmissionDenied()
            const participant = await deps.elevate(ticket)
            if (
              !live() ||
              participant.sid !== initial.sid ||
              participant.identity !== ticket.identity
            )
              throw new AdmissionDenied()
            return participant
          })
          if (!live()) return
          const permission = permitted.permission
          if (
            !permission ||
            permission.canPublish !== ticket.canPublish ||
            permission.canSubscribe !== ticket.canSubscribe ||
            permission.canPublishData !== ticket.canPublishData
          )
            throw new Error('permission elevation not confirmed')
          join.participant = permitted
          join.clientConfiguration ??= new ClientConfiguration()
          join.clientConfiguration.resumeConnection = ClientConfigSetting.DISABLED
          admitted = true
          clearTimeout(timer)
          send(client, Buffer.from(response.toBinary()), true)
          for (const frame of pendingClient.splice(0))
            if (upstream) send(upstream, frame.data, frame.binary)
          queuedBytes = 0
          return
        }
        if (response.message.case === 'refreshToken') {
          const refreshed = await verifySfuToken(response.message.value)
          if (refreshed.identity !== admission.identity || refreshed.room !== admission.room)
            throw new Error('unexpected token refresh scope')
          // Never expose LiveKit's upgraded JWT. The replacement works only at this gate.
          // The first refresh can still carry bootstrap (all-false) grants. Preserve the
          // authorized ticket's scope, not a stale SFU grant snapshot; re-check DB on rejoin.
          response.message.value = await signAdmission(admission, 600)
          send(client, Buffer.from(response.toBinary()), true)
        } else {
          send(client, data, binary)
        }
      }

      async function begin(): Promise<void> {
        const p = parameters(req.url)
        admission = await verifyAdmissionToken(requestToken(p, req.headers.authorization))
        context.userId = admission.userId
        if ([...activeAdmissions].filter((a) => a.userId === admission!.userId).length > 10)
          throw new AdmissionDenied()
        await deps.access(admission, async (serverId) => {
          context.serverId = serverId
        })
        if (!live()) return
        if (p.get('reconnect') && p.get('reconnect') !== '0' && p.get('reconnect') !== 'false') {
          const leave = new SignalResponse({
            message: {
              case: 'leave',
              value: new LeaveRequest({
                canReconnect: true,
                action: LeaveRequest_Action.RECONNECT,
                reason: DisconnectReason.STATE_MISMATCH,
              }),
            },
          })
          send(client, Buffer.from(leave.toBinary()), true)
          close(1012, 'full-reconnect-required')
          return
        }
        const bootstrap = await deps.bootstrap(admission)
        if (!live()) return
        upstream = new WebSocket(upstreamUrl(p, bootstrap), {
          maxPayload: MAX_BYTES,
          handshakeTimeout: 4000,
          followRedirects: false,
        })
        upstream.on('error', () => close(1011, 'upstream-unavailable'))
        upstream.on('close', () => close(1000, 'upstream-closed'))
        upstream.on('message', (raw, binary) => {
          if (closed) return
          const data = bytes(raw)
          pendingServerBytes += data.length
          if (++pendingServerFrames > MAX_FRAMES || pendingServerBytes > MAX_BYTES) {
            close(4429, 'upstream-buffer-full')
            return
          }
          serverTail = serverTail
            .then(() => processServerFrame(data, binary))
            .catch(fail)
            .finally(() => {
              pendingServerFrames -= 1
              pendingServerBytes -= data.length
            })
        })
      }
      void begin().catch(fail)
    })
  }
}
