import { describe, it, expect } from 'vitest'
import { Semaphore } from '../src/utils/semaphore.js'

describe('Semaphore', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5])(
    'throws when max is not a positive integer: %s',
    (max) => {
      expect(() => new Semaphore(max)).toThrow(RangeError)
      expect(() => new Semaphore(max)).toThrow('Semaphore max must be a positive integer')
    },
  )

  it('throws when releasing without a matching acquire', () => {
    const sem = new Semaphore(1)

    expect(() => sem.release()).toThrow('without a matching acquire')
    expect(sem.active).toBe(0)
  })

  it('throws on a second release for the same acquisition', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()
    sem.release()

    expect(() => sem.release()).toThrow('without a matching acquire')
    expect(sem.active).toBe(0)
  })

  it('exposes configured limit', () => {
    expect(new Semaphore(5).limit).toBe(5)
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

  it('hands released slots to queued callers in FIFO order', async () => {
    const sem = new Semaphore(1)
    const order: string[] = []
    await sem.acquire()

    const second = sem.acquire().then(() => { order.push('second') })
    const third = sem.acquire().then(() => { order.push('third') })
    expect(sem.pending).toBe(2)

    sem.release()
    await second
    expect(order).toEqual(['second'])
    expect(sem.active).toBe(1)
    expect(sem.pending).toBe(1)

    sem.release()
    await third
    expect(order).toEqual(['second', 'third'])
    expect(sem.active).toBe(1)
    expect(sem.pending).toBe(0)

    sem.release()
    expect(sem.active).toBe(0)
  })
})
