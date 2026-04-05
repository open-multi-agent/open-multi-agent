/**
 * @fileoverview Inter-agent message bus.
 *
 * Provides a lightweight pub/sub system so agents can exchange typed messages
 * without direct references to each other. All messages are retained in memory
 * for replay and audit; read-state is tracked per recipient.
 */

import { randomUUID } from 'node:crypto'
import type { MessageStore, StoredMessage } from '../types.js'

// ---------------------------------------------------------------------------
// Message type
// ---------------------------------------------------------------------------

/** A single message exchanged between agents (or broadcast to all). */
export interface Message {
  /** Stable UUID for this message. */
  readonly id: string
  /** Name of the sending agent. */
  readonly from: string
  /**
   * Recipient agent name, or `'*'` when the message is a broadcast intended
   * for every agent except the sender.
   */
  readonly to: string
  readonly content: string
  readonly timestamp: Date
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns true when `message` is addressed to `agentName`. */
function isAddressedTo(message: Message, agentName: string): boolean {
  if (message.to === '*') {
    // Broadcasts are delivered to everyone except the sender.
    return message.from !== agentName
  }
  return message.to === agentName
}

// ---------------------------------------------------------------------------
// MessageBus
// ---------------------------------------------------------------------------

/**
 * In-memory message bus for inter-agent communication.
 *
 * Agents can send point-to-point messages or broadcasts. Subscribers are
 * notified synchronously (within the same microtask) when a new message
 * arrives addressed to them.
 *
 * @example
 * ```ts
 * const bus = new MessageBus()
 *
 * const unsubscribe = bus.subscribe('worker', (msg) => {
 *   console.log(`worker received: ${msg.content}`)
 * })
 *
 * bus.send('coordinator', 'worker', 'Start task A')
 * bus.broadcast('coordinator', 'All agents: stand by')
 *
 * unsubscribe()
 * ```
 */
export class MessageBus {
  private readonly messages: Message[] = []
  private readonly readState = new Map<string, Set<string>>()
  private readonly subscribers = new Map<
    string,
    Map<symbol, (message: Message) => void>
  >()
  private readonly store: MessageStore | undefined

  constructor(store?: MessageStore) {
    this.store = store
  }

  // ---------------------------------------------------------------------------
  // Write operations
  // ---------------------------------------------------------------------------

  /**
   * Send a message from `from` to `to`.
   *
   * @returns The persisted {@link Message} including its generated ID and timestamp.
   */
  send(from: string, to: string, content: string): Message {
    const message: Message = {
      id: randomUUID(),
      from,
      to,
      content,
      timestamp: new Date(),
    }
    this.persist(message)
    return message
  }

  /**
   * Broadcast a message from `from` to all other agents (`to === '*'`).
   *
   * @returns The persisted broadcast {@link Message}.
   */
  broadcast(from: string, content: string): Message {
    return this.send(from, '*', content)
  }

  // ---------------------------------------------------------------------------
  // Read operations
  // ---------------------------------------------------------------------------

  /**
   * Returns messages that have not yet been marked as read by `agentName`,
   * including both direct messages and broadcasts addressed to them.
   */
  getUnread(agentName: string): Message[] {
    const read = this.readState.get(agentName) ?? new Set<string>()
    return this.messages.filter(
      (m) => isAddressedTo(m, agentName) && !read.has(m.id),
    )
  }

  /**
   * Returns every message (read or unread) addressed to `agentName`,
   * preserving insertion order.
   */
  getAll(agentName: string): Message[] {
    return this.messages.filter((m) => isAddressedTo(m, agentName))
  }

  /**
   * Mark a set of messages as read for `agentName`.
   * Passing IDs that were already marked, or do not exist, is a no-op.
   */
  markRead(agentName: string, messageIds: string[]): void {
    if (messageIds.length === 0) return
    let read = this.readState.get(agentName)
    if (!read) {
      read = new Set<string>()
      this.readState.set(agentName, read)
    }
    for (const id of messageIds) {
      read.add(id)
    }
  }

  /**
   * Returns all messages exchanged between `agent1` and `agent2` (in either
   * direction), sorted chronologically.
   */
  getConversation(agent1: string, agent2: string): Message[] {
    return this.messages.filter(
      (m) =>
        (m.from === agent1 && m.to === agent2) ||
        (m.from === agent2 && m.to === agent1),
    )
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to new messages addressed to `agentName`.
   *
   * The `callback` is invoked synchronously after each matching message is
   * persisted. Returns an unsubscribe function; calling it is idempotent.
   *
   * @example
   * ```ts
   * const off = bus.subscribe('agent-b', (msg) => handleMessage(msg))
   * // Later…
   * off()
   * ```
   */
  subscribe(
    agentName: string,
    callback: (message: Message) => void,
  ): () => void {
    let agentSubs = this.subscribers.get(agentName)
    if (!agentSubs) {
      agentSubs = new Map()
      this.subscribers.set(agentName, agentSubs)
    }
    const id = Symbol()
    agentSubs.set(id, callback)
    return () => {
      agentSubs!.delete(id)
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private persist(message: Message): void {
    this.messages.push(message)
    if (this.store) {
      this.store.save(MessageBus.toStored(message)).catch(() => {})
    }
    this.notifySubscribers(message)
  }

  private static toStored(message: Message): StoredMessage {
    return {
      id: message.id,
      from: message.from,
      to: message.to,
      content: message.content,
      timestamp: message.timestamp.toISOString(),
    }
  }

  private notifySubscribers(message: Message): void {
    // Notify direct subscribers of `message.to` (unless broadcast).
    if (message.to !== '*') {
      this.fireCallbacks(message.to, message)
      return
    }

    // Broadcast: notify all subscribers except the sender.
    for (const [agentName, subs] of this.subscribers) {
      if (agentName !== message.from && subs.size > 0) {
        this.fireCallbacks(agentName, message)
      }
    }
  }

  private fireCallbacks(agentName: string, message: Message): void {
    const subs = this.subscribers.get(agentName)
    if (!subs) return
    for (const callback of subs.values()) {
      callback(message)
    }
  }
}
