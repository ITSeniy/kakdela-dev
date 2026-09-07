import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyBaseLogger } from 'fastify'
const mocks = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn(), broadcast: vi.fn() }))
vi.mock('./db.js', () => ({ db: { select: mocks.select, update: mocks.update } }))
vi.mock('../ws/broadcast.js', () => ({ broadcastToChannel: mocks.broadcast }))
import { startAutoDeleteSweeper, sweepOnce } from './auto-delete.js'
const logger = { info: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger
beforeEach(() => vi.resetAllMocks())
afterEach(() => vi.useRealTimers())
describe('auto-delete batching', () => {
  it('publishes every one of 1001 deleted IDs, in bounded batches', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ id: String(i) }))
    let batch: typeof rows = []
    mocks.select.mockImplementation((columns) => ({ from: () => ({ where: () => {
      if ('sec' in columns) return Promise.resolve([{ id: 'channel', sec: 1 }])
      return { orderBy: () => ({ limit: (limit: number) => { expect(limit).toBe(1000); batch = rows.splice(0, limit); return Promise.resolve(batch) } }) }
    } }) }))
    mocks.update.mockImplementation(() => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve(batch) }) }) }))
    mocks.broadcast.mockResolvedValue(undefined)
    await sweepOnce(logger)
    expect(mocks.update).toHaveBeenCalledTimes(2)
    expect(mocks.broadcast).toHaveBeenCalledTimes(1001)
    expect(new Set(mocks.broadcast.mock.calls.map((call) => call[1].messageId)).size).toBe(1001)
  })
  it('does not overlap timer-driven sweeps', async () => {
    vi.useFakeTimers()
    let release!: (value: unknown[]) => void
    mocks.select.mockReturnValue({ from: () => ({ where: () => new Promise((resolve) => { release = resolve }) }) })
    const stop = startAutoDeleteSweeper(logger)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(2 * 30 * 60_000)
    expect(mocks.select).toHaveBeenCalledTimes(1)
    release([])
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(mocks.select).toHaveBeenCalledTimes(2)
    release([])
    stop()
  })
})
