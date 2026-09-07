// Isolated signaling smoke test. Never uses compose, mounts, .env or production services.
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = fileURLToPath(new URL('../packages/speedy/', import.meta.url))
const require = createRequire(new URL('../packages/speedy/package.json', import.meta.url))
const vitest = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const name = 'pizza-revocation-test-' + randomUUID()
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
let created = false
try {
  // Pin to the cached image ID for this run; do not pull or change the user's image.
  const image = docker('image', 'inspect', 'livekit/livekit-server@sha256:b617bb3363f13e880a82164692d842681276bc6eed7da46092f9ddb22017b927', '--format', '{{.Id}}')
  if (!/^sha256:[0-9a-f]{64}$/.test(image)) throw new Error('invalid cached image ID')
  console.log('Disposable LiveKit image:', image)
  docker('create', '--pull=never', '--name', name, '--label', 'pizza.revocation.disposable=true', '--memory=512m', '-p', '127.0.0.1::7880', image, '--dev', '--bind', '0.0.0.0', '--keys', 'auditkey: synthetic-audit-livekit-secret-32chars')
  created = true
  docker('start', name)
  const port = docker('port', name, '7880/tcp').split(':').at(-1)
  if (!/^\d+$/.test(port)) throw new Error('unexpected disposable port')
  const url = 'http://127.0.0.1:' + port
  let ready = false
  for (let i = 0; i < 30; i++) {
    try { const res = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (res.ok) { ready = true; break } } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!ready) throw new Error('disposable LiveKit did not become ready')
  const result = spawnSync(process.execPath, [vitest, 'run', 'src/media/livekit.integration.test.ts'], {
    cwd: packageDir, stdio: 'inherit', timeout: 60000,
    env: { ...process.env, AUDIT_LIVEKIT_URL: url },
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  if (created) { docker('rm', '-f', name); console.log('Disposable LiveKit removed.') }
}
