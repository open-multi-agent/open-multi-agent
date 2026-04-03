import { describe, it, expect } from 'vitest'
import { Semaphore } from '../src/utils/semaphore.js'

describe('Semaphore', () => {
  it('throws on max < 1', () => {
    expect(() => new Semaphore(0)).toThrow()
  })

  it('allows up to max concurrent holders', async () => {
    const sem = new Semaphore(2)
    let running = 0
    let peak = 0

    const work = async () => {
      await sem.acquire()
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 30))
      running--
      sem.release()
    }

    await Promise.all([work(), work(), work(), work()])
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('run() auto-releases on success', async () => {
    const sem = new Semaphore(1)
    const result = await sem.run(async () => 42)
    expect(result).toBe(42)
    expect(sem.active).toBe(0)
  })

  it('run() auto-releases on error', async () => {
    const sem = new Semaphore(1)
    await expect(sem.run(async () => { throw new Error('oops') })).rejects.toThrow('oops')
    expect(sem.active).toBe(0)
  })

  it('tracks active and pending counts', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()
    expect(sem.active).toBe(1)

    // This will queue
    const p = sem.acquire()
    expect(sem.pending).toBe(1)

    sem.release()
    await p
    expect(sem.active).toBe(1)
    expect(sem.pending).toBe(0)

    sem.release()
    expect(sem.active).toBe(0)
  })
})
