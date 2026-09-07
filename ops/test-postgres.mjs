// Disposable PostgreSQL only; no compose files, mounts, real credentials or deployed services.
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const packageDir = fileURLToPath(new URL('../packages/speedy/', import.meta.url))
const require = createRequire(new URL('../packages/speedy/package.json', import.meta.url))
const vitest = resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const name = 'pizza-audit-test-' + randomUUID()
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
let started = false
try {
  docker('run', '-d', '--rm', '--name', name, '--label', 'pizza.audit.disposable=true', '--memory=512m', '-e', 'POSTGRES_PASSWORD=audit-test-only', '-e', 'POSTGRES_DB=pizza_audit_test', '-p', '127.0.0.1::5432', 'postgres:17-alpine')
  started = true
  let ready = false
  for (let i = 0; i < 30; i++) {
    try { docker('exec', name, 'pg_isready', '-U', 'postgres'); ready = true; break } catch { await new Promise((r) => setTimeout(r, 1000)) }
  }
  if (!ready) throw new Error('disposable database did not become ready')
  const port = docker('port', name, '5432/tcp').split(':').at(-1)
  if (!/^\d+$/.test(port)) throw new Error('unexpected disposable port')
  const env = { ...process.env, AUDIT_DATABASE_URL: 'postgres://postgres:audit-test-only@127.0.0.1:' + port + '/pizza_audit_test' }
  // Suites share one disposable DB: never run their TRUNCATE fixtures in parallel.
  const result = spawnSync(process.execPath, [vitest, 'run', '--no-file-parallelism', 'src/routes/audit.integration.test.ts', 'src/ws/access.integration.test.ts', 'src/routes/revocation.integration.test.ts'], { cwd: packageDir, stdio: 'inherit', env, timeout: 120000 })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  if (started) { docker('rm', '-f', name); console.log('Disposable PostgreSQL removed.') }
}
