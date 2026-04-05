import type { KVStore } from '../types.js'

export interface RedisStoreOptions {
  readonly keyPrefix?: string
}

export class RedisStore implements KVStore {
  private readonly client: {
    hSet(key: string, ...fields: [string, string][]): Promise<number>
    hGet(key: string, field: string): Promise<string | undefined>
    del(...keys: string[]): Promise<number>
    scanIterator(options?: { MATCH?: string; COUNT?: number }): AsyncIterable<string[]>
  }
  private readonly prefix: string

  constructor(
    client: RedisStore['client'],
    options?: RedisStoreOptions,
  ) {
    this.client = client
    this.prefix = options?.keyPrefix ?? ''
  }

  private fullKey(key: string): string {
    return this.prefix ? `${this.prefix}:${key}` : key
  }

  async get(key: string): Promise<string | null> {
    const value = await this.client.hGet(this.fullKey(key), 'value')
    return value ?? null
  }

  async set(key: string, value: string): Promise<void> {
    await this.client.hSet(this.fullKey(key), ['value', value])
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.fullKey(key))
  }

  async list(): Promise<string[]> {
    const pattern = this.prefix ? `${this.prefix}:*` : '*'
    const keys: string[] = []
    for await (const batch of this.client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      for (const k of batch) {
        const stripped = this.prefix ? k.slice(this.prefix.length + 1) : k
        keys.push(stripped)
      }
    }
    return keys
  }

  async clear(): Promise<void> {
    const keys = await this.list()
    if (keys.length === 0) return
    const fullKeys = keys.map((k) => this.fullKey(k))
    await this.client.del(...fullKeys)
  }
}
