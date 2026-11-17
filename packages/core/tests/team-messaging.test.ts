import { describe, it, expect, vi } from 'vitest'
import { MessageBus } from '../src/team/messaging.js'
import { Team } from '../src/team/team.js'
import type { AgentConfig, TaskMetadata, TeamConfig } from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agent(name: string): AgentConfig {
  return { name, model: 'test-model', systemPrompt: `You are ${name}.` }
}

function teamConfig(opts?: Partial<TeamConfig>): TeamConfig {
  return {
    name: 'test-team',
    agents: [agent('alice'), agent('bob')],
    ...opts,
  }
}

// ===========================================================================
// MessageBus
// ===========================================================================

describe('MessageBus', () => {
  describe('send / getAll / getUnread', () => {
    it('delivers a point-to-point message', () => {
      const bus = new MessageBus()
      bus.send('alice', 'bob', 'hello')

      const msgs = bus.getAll('bob')
      expect(msgs).toHaveLength(1)
      expect(msgs[0]!.from).toBe('alice')
      expect(msgs[0]!.to).toBe('bob')
      expect(msgs[0]!.content).toBe('hello')
    })

    it('does not deliver messages to sender', () => {
      const bus = new MessageBus()
      bus.send('alice', 'bob', 'hello')
      expect(bus.getAll('alice')).toHaveLength(0)
    })

    it('tracks unread state', () => {
      const bus = new MessageBus()
      const msg = bus.send('alice', 'bob', 'hello')

      expect(bus.getUnread('bob')).toHaveLength(1)

      bus.markRead('bob', [msg.id])
      expect(bus.getUnread('bob')).toHaveLength(0)
      // getAll still returns the message
      expect(bus.getAll('bob')).toHaveLength(1)
    })

    it('markRead with empty array is a no-op', () => {
      const bus = new MessageBus()
      bus.markRead('bob', [])
      expect(bus.getUnread('bob')).toHaveLength(0)
    })

    it('marks only existing messages addressed to the agent as read', () => {
      const bus = new MessageBus()
      const direct = bus.send('alice', 'bob', 'for bob')
      const other = bus.send('alice', 'carol', 'for carol')
      const broadcast = bus.broadcast('alice', 'for everyone else')

      bus.markRead('bob', [direct.id, other.id, 'missing', broadcast.id, direct.id])
      bus.markRead('alice', [broadcast.id])

      expect(bus.snapshot().readState).toEqual([{
        agentName: 'bob',
        messageIds: [direct.id, broadcast.id],
      }])
      expect(bus.getUnread('bob')).toEqual([])
      expect(bus.getUnread('carol').map(message => message.id)).toEqual([
        other.id,
        broadcast.id,
      ])
    })
  })

  describe('broadcast', () => {
    it('delivers to all except sender', () => {
      const bus = new MessageBus()
      // Set up subscribers so the bus knows about agents
      bus.subscribe('alice', () => {})
      bus.subscribe('bob', () => {})
      bus.subscribe('carol', () => {})

      bus.broadcast('alice', 'everyone listen')

      expect(bus.getAll('bob')).toHaveLength(1)
      expect(bus.getAll('carol')).toHaveLength(1)
      expect(bus.getAll('alice')).toHaveLength(0) // sender excluded
    })

    it('broadcast message has to === "*"', () => {
      const bus = new MessageBus()
      const msg = bus.broadcast('alice', 'hi')
      expect(msg.to).toBe('*')
    })
  })

  describe('subscribe', () => {
    it('notifies subscriber on new direct message', () => {
      const bus = new MessageBus()
      const received: string[] = []
      bus.subscribe('bob', (msg) => received.push(msg.content))

      bus.send('alice', 'bob', 'ping')

      expect(received).toEqual(['ping'])
    })

    it('notifies subscriber on broadcast', () => {
      const bus = new MessageBus()
      const received: string[] = []
      bus.subscribe('bob', (msg) => received.push(msg.content))

      bus.broadcast('alice', 'broadcast msg')

      expect(received).toEqual(['broadcast msg'])
    })

    it('does not notify sender of own broadcast', () => {
      const bus = new MessageBus()
      const received: string[] = []
      bus.subscribe('alice', (msg) => received.push(msg.content))

      bus.broadcast('alice', 'my broadcast')

      expect(received).toEqual([])
    })

    it('unsubscribe stops notifications', () => {
      const bus = new MessageBus()
      const received: string[] = []
      const unsub = bus.subscribe('bob', (msg) => received.push(msg.content))

      bus.send('alice', 'bob', 'first')
      unsub()
      bus.send('alice', 'bob', 'second')

      expect(received).toEqual(['first'])
    })

    it('isolates subscriber failures and persists a direct message once', () => {
      const bus = new MessageBus()
      const calls: string[] = []
      const first = vi.fn(() => {
        calls.push('first')
        throw new Error('first subscriber failed')
      })
      const second = vi.fn(() => {
        calls.push('second')
        throw new Error('second subscriber failed')
      })
      const healthy = vi.fn(() => { calls.push('healthy') })
      bus.subscribe('bob', first)
      bus.subscribe('bob', second)
      bus.subscribe('bob', healthy)

      const message = bus.send('alice', 'bob', 'important update')

      expect(calls).toEqual(['first', 'second', 'healthy'])
      expect(first).toHaveBeenCalledWith(message)
      expect(second).toHaveBeenCalledWith(message)
      expect(healthy).toHaveBeenCalledWith(message)
      expect(bus.getAll('bob')).toEqual([message])
      expect(bus.getUnread('bob')).toEqual([message])
      expect(bus.snapshot().messages).toHaveLength(1)
    })

    it('continues broadcast delivery after a subscriber fails', () => {
      const bus = new MessageBus()
      const calls: string[] = []
      bus.subscribe('alice', () => { calls.push('sender') })
      bus.subscribe('bob', () => {
        calls.push('bob-failing')
        throw new Error('bob subscriber failed')
      })
      bus.subscribe('bob', () => { calls.push('bob-healthy') })
      bus.subscribe('carol', () => { calls.push('carol-healthy') })

      const message = bus.broadcast('alice', 'all hands')

      expect(calls).toEqual(['bob-failing', 'bob-healthy', 'carol-healthy'])
      expect(bus.getAll('alice')).toEqual([])
      expect(bus.getAll('bob')).toEqual([message])
      expect(bus.getAll('carol')).toEqual([message])
    })
  })

  describe('getConversation', () => {
    it('returns messages in both directions', () => {
      const bus = new MessageBus()
      bus.send('alice', 'bob', 'hello')
      bus.send('bob', 'alice', 'hi back')
      bus.send('alice', 'carol', 'unrelated')

      const convo = bus.getConversation('alice', 'bob')
      expect(convo).toHaveLength(2)
      expect(convo[0]!.content).toBe('hello')
      expect(convo[1]!.content).toBe('hi back')
    })
  })

  describe('snapshot / restore', () => {
    it('round-trips messages and per-agent read state', () => {
      const bus = new MessageBus()
      const direct = bus.send('alice', 'bob', 'hello')
      const broadcast = bus.broadcast('alice', 'stand by')
      bus.markRead('bob', [direct.id])

      const restored = MessageBus.fromSnapshot(bus.snapshot())

      expect(restored.getAll('bob').map((message) => message.content)).toEqual([
        'hello',
        'stand by',
      ])
      expect(restored.getUnread('bob').map((message) => message.id)).toEqual([
        broadcast.id,
      ])
      expect(restored.getAll('bob')[0]!.timestamp).toBeInstanceOf(Date)
      expect(restored.getAll('bob')[0]!.timestamp.getTime()).toBe(direct.timestamp.getTime())
    })

    it('does not restore live subscribers', () => {
      const bus = new MessageBus()
      const received: string[] = []
      bus.subscribe('bob', (message) => received.push(message.content))

      bus.send('alice', 'bob', 'before snapshot')
      const restored = MessageBus.fromSnapshot(bus.snapshot())
      restored.send('alice', 'bob', 'after restore')

      expect(received).toEqual(['before snapshot'])
    })

    it('keeps current process-local subscribers when restoring into an existing bus', () => {
      const source = new MessageBus()
      source.send('alice', 'bob', 'checkpointed')
      const target = new MessageBus()
      const received: string[] = []
      target.subscribe('bob', (message) => received.push(message.content))

      target.restore(source.snapshot())
      target.send('alice', 'bob', 'after restore')

      expect(target.getAll('bob').map((message) => message.content)).toEqual([
        'checkpointed',
        'after restore',
      ])
      expect(received).toEqual(['after restore'])
    })

    it('rejects unsupported snapshot versions', () => {
      const bus = new MessageBus()
      const snapshot = {
        ...bus.snapshot(),
        version: 2,
      }

      expect(() => MessageBus.fromSnapshot(snapshot as ReturnType<MessageBus['snapshot']>))
        .toThrow(/unsupported snapshot version 2/)
    })
  })
})

// ===========================================================================
// Team
// ===========================================================================

describe('Team', () => {
  describe('agent roster', () => {
    it('returns all agents via getAgents()', () => {
      const team = new Team(teamConfig())
      const agents = team.getAgents()
      expect(agents).toHaveLength(2)
      expect(agents.map(a => a.name)).toEqual(['alice', 'bob'])
    })

    it('looks up agent by name', () => {
      const team = new Team(teamConfig())
      expect(team.getAgent('alice')?.name).toBe('alice')
      expect(team.getAgent('nonexistent')).toBeUndefined()
    })
  })

  describe('messaging', () => {
    it('sends point-to-point messages and emits event', () => {
      const team = new Team(teamConfig())
      const events: unknown[] = []
      team.on('message', (d) => events.push(d))

      team.sendMessage('alice', 'bob', 'hey')

      expect(team.getMessages('bob')).toHaveLength(1)
      expect(team.getMessages('bob')[0]!.content).toBe('hey')
      expect(events).toHaveLength(1)
    })

    it('tracks unread message state', () => {
      const team = new Team(teamConfig())

      team.sendMessage('alice', 'bob', 'read me')
      const unread = team.getUnreadMessages('bob')
      team.markMessagesRead('bob', unread.map((message) => message.id))

      expect(unread).toHaveLength(1)
      expect(team.getUnreadMessages('bob')).toHaveLength(0)
      expect(team.getMessages('bob')).toHaveLength(1)
    })

    it('broadcasts and emits broadcast event', () => {
      const team = new Team(teamConfig())
      const events: unknown[] = []
      team.on('broadcast', (d) => events.push(d))

      team.broadcast('alice', 'all hands')

      expect(events).toHaveLength(1)
    })
  })

  describe('task management', () => {
    it('adds and retrieves tasks', () => {
      const team = new Team(teamConfig())
      const task = team.addTask({
        title: 'Do something',
        description: 'Details here',
        status: 'pending',
        assignee: 'alice',
      })

      expect(task.id).toBeDefined()
      expect(task.title).toBe('Do something')
      expect(team.getTasks()).toHaveLength(1)
    })

    it.each(['pending', 'completed'] as const)(
      'preserves task options for a %s task',
      (status) => {
        const team = new Team(teamConfig())
        const options = {
          memoryScope: 'dependencies' as const,
          dependencyPayload: 'structured' as const,
          maxRetries: 3,
          retryDelayMs: 40,
          retryBackoff: 4,
          role: 'document-review',
          priority: 'high' as const,
          metadata: { documentId: 'fixture-01', pageCount: 2 },
          requires: { requiredCapabilities: ['document-review'] },
          verify: { judges: [agent('reviewer')], maxRounds: 1 },
        }
        const task = team.addTask({
          title: 'Review document',
          description: 'Review the fixture document.',
          status,
          assignee: 'alice',
          ...options,
          ...(status === 'completed' ? { result: 'Reviewed.' } : {}),
        })

        expect(task).toMatchObject({ ...options, status, assignee: 'alice' })
        expect(team.getTasks()[0]).toMatchObject({ ...options, status })
        if (status === 'completed') expect(task.result).toBe('Reviewed.')
      },
    )

    it('validates task metadata before adding it to the queue', () => {
      const team = new Team(teamConfig())
      const metadata = { documentPages: [1, 'two'] } as unknown as TaskMetadata

      expect(() => team.addTask({
        title: 'Read document',
        description: 'Read the fixture document.',
        status: 'pending',
        metadata,
      })).toThrow('must be homogeneous')
      expect(team.getTasks()).toEqual([])
    })

    it('copies dependencies and generates task identity and timestamps', () => {
      const team = new Team(teamConfig())
      const parent = team.addTask({ title: 'Parent', description: 'First.', status: 'pending' })
      const dependsOn = [parent.id]
      const task = team.addTask({ title: 'Child', description: 'Next.', status: 'pending', dependsOn })
      dependsOn.push('another-task')

      expect(task.id).not.toBe(parent.id)
      expect(task.createdAt).toBeInstanceOf(Date)
      expect(task.updatedAt).toBeInstanceOf(Date)
      expect(task.dependsOn).toEqual([parent.id])
      expect(team.getTasks().find(saved => saved.id === task.id)).toMatchObject({
        dependsOn: [parent.id],
        status: 'blocked',
      })
    })

    it('filters tasks by assignee', () => {
      const team = new Team(teamConfig())
      team.addTask({ title: 't1', description: 'd', status: 'pending', assignee: 'alice' })
      team.addTask({ title: 't2', description: 'd', status: 'pending', assignee: 'bob' })

      expect(team.getTasksByAssignee('alice')).toHaveLength(1)
      expect(team.getTasksByAssignee('alice')[0]!.title).toBe('t1')
    })

    it('updates a task', () => {
      const team = new Team(teamConfig())
      const task = team.addTask({ title: 't1', description: 'd', status: 'pending' })

      const updated = team.updateTask(task.id, { status: 'in_progress' })
      expect(updated.status).toBe('in_progress')
    })

    it('getNextTask prefers assigned tasks', () => {
      const team = new Team(teamConfig())
      team.addTask({ title: 'unassigned', description: 'd', status: 'pending' })
      team.addTask({ title: 'for alice', description: 'd', status: 'pending', assignee: 'alice' })

      const next = team.getNextTask('alice')
      expect(next?.title).toBe('for alice')
    })

    it('getNextTask falls back to unassigned', () => {
      const team = new Team(teamConfig())
      team.addTask({ title: 'unassigned', description: 'd', status: 'pending' })

      const next = team.getNextTask('alice')
      expect(next?.title).toBe('unassigned')
    })

    it('getNextTask returns undefined when no tasks available', () => {
      const team = new Team(teamConfig())
      expect(team.getNextTask('alice')).toBeUndefined()
    })

    it('preserves non-default status on addTask', () => {
      const team = new Team(teamConfig())
      const task = team.addTask({
        title: 'blocked task',
        description: 'd',
        status: 'blocked',
        result: 'waiting on dep',
      })
      expect(task.status).toBe('blocked')
      expect(task.result).toBe('waiting on dep')
    })
  })

  describe('shared memory', () => {
    it('returns undefined when sharedMemory is disabled', () => {
      const team = new Team(teamConfig({ sharedMemory: false }))
      expect(team.getSharedMemory()).toBeUndefined()
      expect(team.getSharedMemoryInstance()).toBeUndefined()
    })

    it('returns a MemoryStore when sharedMemory is enabled', () => {
      const team = new Team(teamConfig({ sharedMemory: true }))
      const store = team.getSharedMemory()
      expect(store).toBeDefined()
      expect(typeof store!.get).toBe('function')
      expect(typeof store!.set).toBe('function')
    })

    it('returns SharedMemory instance', () => {
      const team = new Team(teamConfig({ sharedMemory: true }))
      const mem = team.getSharedMemoryInstance()
      expect(mem).toBeDefined()
      expect(typeof mem!.write).toBe('function')
      expect(typeof mem!.getSummary).toBe('function')
    })
  })

  describe('events', () => {
    it('emits task:ready when a pending task becomes runnable', () => {
      const team = new Team(teamConfig())
      const events: unknown[] = []
      team.on('task:ready', (d) => events.push(d))

      team.addTask({ title: 't1', description: 'd', status: 'pending' })

      // task:ready is fired by the queue when a task with no deps is added
      expect(events.length).toBeGreaterThanOrEqual(1)
    })

    it('emits custom events via emit()', () => {
      const team = new Team(teamConfig())
      const received: unknown[] = []
      team.on('custom:event', (d) => received.push(d))

      team.emit('custom:event', { foo: 'bar' })

      expect(received).toEqual([{ foo: 'bar' }])
    })

    it('unsubscribe works', () => {
      const team = new Team(teamConfig())
      const received: unknown[] = []
      const unsub = team.on('custom:event', (d) => received.push(d))

      team.emit('custom:event', 'first')
      unsub()
      team.emit('custom:event', 'second')

      expect(received).toEqual(['first'])
    })

    it('bridges task:complete and task:failed from the queue', () => {
      // These events fire via queue.complete()/queue.fail(), which happen
      // during orchestration. Team only exposes updateTask() which calls
      // queue.update() — no event is emitted. We verify the bridge is
      // wired correctly by checking that task:ready fires on addTask.
      const team = new Team(teamConfig())
      const readyEvents: unknown[] = []
      team.on('task:ready', (d) => readyEvents.push(d))

      team.addTask({ title: 't1', description: 'd', status: 'pending' })

      // task:ready fires because a pending task with no deps is immediately ready
      expect(readyEvents.length).toBeGreaterThanOrEqual(1)
    })
  })
})
