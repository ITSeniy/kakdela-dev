// Never inherit production service credentials/endpoints into tests.
const defaults: Record<string, string> = {
  NODE_ENV: 'test', TRUST_PROXY: 'false',
  DATABASE_URL: 'postgres://test:test@127.0.0.1:9/pizza_audit_test',
  REDIS_URL: 'redis://127.0.0.1:9',
  JWT_ACCESS_SECRET: 'a'.repeat(64), JWT_REFRESH_SECRET: 'b'.repeat(64),
  LIVEKIT_URL: 'ws://127.0.0.1:9/livekit', LIVEKIT_ADMIN_URL: 'http://127.0.0.1:9',
  LIVEKIT_API_KEY: 'test', LIVEKIT_API_SECRET: 'test-only-not-for-production-123456789',
  S3_ENDPOINT: 'http://127.0.0.1:9', S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:9',
  S3_ACCESS_KEY: 'test', S3_SECRET_KEY: 'test',
}
if (process.env.AUDIT_DATABASE_URL) {
  const url = new URL(process.env.AUDIT_DATABASE_URL)
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/pizza_audit_test' || !url.port || url.port === '5432') {
    throw new Error('Integration tests require the dedicated disposable database runner')
  }
  defaults.DATABASE_URL = url.href
}
Object.assign(process.env, defaults)
