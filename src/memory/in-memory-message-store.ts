import type { MessageFilter, MessageStore, StoredMessage } from '../types.js'

export class InMemoryMessageStore implements MessageStore {
  private readonly messages = new Map<string, StoredMessage>()
  private readonly readState = new Map<string, Set<string>>()

  async save(message: StoredMessage): Promise<void> {
    this.messages.set(message.id, message)
  }

  async get(messageId: string): Promise<StoredMessage | null> {
    return this.messages.get(messageId) ?? null
  }

  async query(filter: MessageFilter): Promise<StoredMessage[]> {
    return Array.from(this.messages.values()).filter((m) => {
      if (filter.to !== undefined && m.to !== filter.to) return false
      if (filter.from !== undefined && m.from !== filter.from) return false
      return true
    })
  }

  async markRead(agentName: string, messageIds: string[]): Promise<void> {
    let read = this.readState.get(agentName)
    if (!read) {
      read = new Set<string>()
      this.readState.set(agentName, read)
    }
    for (const id of messageIds) {
      read.add(id)
    }
  }

  async getUnreadIds(agentName: string): Promise<Set<string>> {
    const read = this.readState.get(agentName) ?? new Set<string>()
    const unread = new Set<string>()
    for (const m of this.messages.values()) {
      if (m.to === agentName && !read.has(m.id)) {
        unread.add(m.id)
      }
    }
    return unread
  }
}
