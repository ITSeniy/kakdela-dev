// Dedicated ephemeral PostgreSQL + LiveKit. No compose, production .env or volume mounts.
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = fileURLToPath(new URL('../packages/speedy/', import.meta.url))
const require = createRequire(new URL('../packages/speedy/package.json', import.meta.url))
const vitest = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const prefix = 'pizza-admission-' + randomUUID()
const created = []
const media = process.argv.includes('--media')
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
function create(name, args) {
  docker(
    'create',
    '--pull=never',
    '--name',
    name,
    '--label',
    'pizza.admission.disposable=true',
    '--memory=512m',
    ...args,
  )
  created.push(name)
  docker('start', name)
}
function port(name, containerPort) {
  const value = docker('port', name, containerPort).split(':').at(-1)
  if (!/^\d+$/.test(value)) throw new Error('invalid loopback port')
  return value
}
try {
  const pg = prefix + '-pg',
    lk = prefix + '-lk'
  let udpPort
  if (media) {
    const socket = createSocket('udp4')
    await new Promise((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(0, '127.0.0.1', resolve)
    })
    udpPort = socket.address().port
    await new Promise((resolve) => socket.close(resolve))
  }
  create(pg, [
    '-e',
    'POSTGRES_PASSWORD=audit-test-only',
    '-e',
    'POSTGRES_DB=pizza_audit_test',
    '-p',
    '127.0.0.1::5432',
    'postgres:17-alpine',
  ])
  let ready = false
  for (let i = 0; i < 30; i++) {
    try {
      docker('exec', pg, 'pg_isready', '-U', 'postgres')
      ready = true
      break
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  if (!ready) throw new Error('disposable PostgreSQL not ready')
  const image = docker(
    'image',
    'inspect',
    'livekit/livekit-server@sha256:b617bb3363f13e880a82164692d842681276bc6eed7da46092f9ddb22017b927',
    '--format',
    '{{.Id}}',
  )
  if (!/^sha256:[0-9a-f]{64}$/.test(image)) throw new Error('invalid cached image ID')
  console.log('LiveKit tested image:', image)
  create(lk, [
    '-p',
    '127.0.0.1::7880',
    ...(media ? ['-p', `127.0.0.1:${udpPort}:${udpPort}/udp`] : []),
    image,
    '--dev',
    '--bind',
    '0.0.0.0',
    '--keys',
    'auditkey: synthetic-audit-livekit-secret-32chars',
    ...(media ? ['--node-ip', '127.0.0.1', '--udp-port', String(udpPort)] : []),
  ])
  const livekitUrl = 'http://127.0.0.1:' + port(lk, '7880/tcp')
  ready = false
  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch(livekitUrl, { signal: AbortSignal.timeout(1000) })).ok) {
        ready = true
        break
      }
    } catch {
      /* booting */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!ready) throw new Error('disposable LiveKit not ready')
  const result = spawnSync(
    process.execPath,
    [vitest, 'run', 'src/media/admission.integration.test.ts'],
    {
      cwd: packageDir,
      stdio: 'inherit',
      timeout: 180000,
      env: {
        ...process.env,
        AUDIT_DATABASE_URL:
          'postgres://postgres:audit-test-only@127.0.0.1:' +
          port(pg, '5432/tcp') +
          '/pizza_audit_test',
        AUDIT_ADMISSION_URL: livekitUrl,
        AUDIT_MEDIA_SMOKE: media ? '1' : '0',
      },
    },
  )
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  const failed = []
  for (const name of created.reverse()) {
    try {
      docker('rm', '-f', name)
    } catch {
      failed.push(name)
    }
  }
  if (failed.length) {
    process.exitCode = 1
    console.error('Disposable cleanup failed:', failed)
  } else console.log('Disposable admission services removed.')
}
