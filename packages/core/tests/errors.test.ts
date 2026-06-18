import { describe, it, expect } from 'vitest'
import { TokenBudgetExceededError, InvalidMessageError } from '../src/errors.js'

describe('TokenBudgetExceededError', () => {
  it('sets .name to TokenBudgetExceededError', () => {
    const err = new TokenBudgetExceededError('agent-1', 500, 400)
    expect(err.name).toBe('TokenBudgetExceededError')
  })

  it('sets .code to TOKEN_BUDGET_EXCEEDED', () => {
    const err = new TokenBudgetExceededError('agent-1', 500, 400)
    expect(err.code).toBe('TOKEN_BUDGET_EXCEEDED')
  })

  it('stores agent, tokensUsed, and budget as readonly properties', () => {
    const err = new TokenBudgetExceededError('worker-a', 1234, 1000)
    expect(err.agent).toBe('worker-a')
    expect(err.tokensUsed).toBe(1234)
    expect(err.budget).toBe(1000)
  })

  it('formats the message with agent name, tokens used, and budget', () => {
    const err = new TokenBudgetExceededError('analyst', 750, 500)
    expect(err.message).toBe('Agent "analyst" exceeded token budget: 750 tokens used (budget: 500)')
  })

  it('is an instance of TokenBudgetExceededError', () => {
    const err = new TokenBudgetExceededError('b', 1, 2)
    expect(err).toBeInstanceOf(TokenBudgetExceededError)
  })

  it('is an instance of Error (extends built-in Error)', () => {
    const err = new TokenBudgetExceededError('b', 1, 2)
    expect(err).toBeInstanceOf(Error)
  })
})

describe('InvalidMessageError', () => {
  it('sets .name to InvalidMessageError', () => {
    const err = new InvalidMessageError('bad content')
    expect(err.name).toBe('InvalidMessageError')
  })

  it('sets .code to INVALID_MESSAGE', () => {
    const err = new InvalidMessageError('some reason')
    expect(err.code).toBe('INVALID_MESSAGE')
  })

  it('uses the constructor argument as the message', () => {
    const err = new InvalidMessageError('content must be a ContentBlock[]')
    expect(err.message).toBe('content must be a ContentBlock[]')
  })

  it('is an instance of InvalidMessageError', () => {
    const err = new InvalidMessageError('test')
    expect(err).toBeInstanceOf(InvalidMessageError)
  })

  it('is an instance of Error (extends built-in Error)', () => {
    const err = new InvalidMessageError('test')
    expect(err).toBeInstanceOf(Error)
  })
})
