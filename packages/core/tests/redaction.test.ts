import { describe, expect, it } from 'vitest'
import { redactSensitiveObject, redactSensitiveText } from '../src/utils/redaction.js'

describe('redactSensitiveText', () => {
  describe('values containing spaces', () => {
    it('redacts unquoted env-style value with a space', () => {
      expect(redactSensitiveText('password=secret value')).toBe('password=[redacted]')
    })

    it('redacts double-quoted value with a space', () => {
      expect(redactSensitiveText('password="secret value"')).toBe('password="[redacted]"')
    })

    it('redacts single-quoted value with a space', () => {
      expect(redactSensitiveText("password='secret value'")).toBe("password='[redacted]'")
    })

    it('redacts JSON-style quoted value with a space', () => {
      expect(redactSensitiveText('apiKey: "abc def"')).toBe('apiKey: "[redacted]"')
    })

    it('redacts quoted key + quoted value with a space', () => {
      expect(redactSensitiveText('"apiKey": "abc def"')).toBe('"apiKey": "[redacted]"')
    })

    it('redacts unquoted value with a tab', () => {
      expect(redactSensitiveText('password=secret\tvalue')).toBe('password=[redacted]')
    })
  })

  describe('multiple assignments on one line', () => {
    it('redacts each sensitive assignment, leaves non-sensitive', () => {
      expect(redactSensitiveText('password=hunter2, username=alice')).toBe(
        'password=[redacted], username=alice',
      )
    })

    it('stops space-containing value at the next comma delimiter', () => {
      expect(redactSensitiveText('password=secret value, username=alice')).toBe(
        'password=[redacted], username=alice',
      )
    })
  })

  describe('regression: existing behavior', () => {
    it('redacts Authorization Bearer header without orphan brackets', () => {
      expect(redactSensitiveText('Authorization: Bearer sk-xxxxxxxxxxxxxxxx')).toBe(
        'Authorization: [redacted]',
      )
    })

    it('leaves non-sensitive assignments untouched', () => {
      expect(redactSensitiveText('username=alice')).toBe('username=alice')
    })

    it('redacts simple unquoted sensitive value', () => {
      expect(redactSensitiveText('password=hunter2')).toBe('password=[redacted]')
    })

    it('redacts OpenAI-style token literal in free text', () => {
      const result = redactSensitiveText('the key is sk-abcdefghijklmnop')
      expect(result).toContain('[redacted]')
      expect(result).not.toContain('sk-abcdefghijklmnop')
    })

    it('redacts PEM private key block', () => {
      const input = '-----BEGIN RSA PRIVATE KEY-----\nMIIEv...\n-----END RSA PRIVATE KEY-----'
      expect(redactSensitiveText(input)).toBe('[redacted]')
    })
  })

  describe('idempotence', () => {
    it('does not re-process already-redacted values', () => {
      const once = redactSensitiveText('password="secret value"')
      const twice = redactSensitiveText(once)
      expect(twice).toBe(once)
    })
  })

  describe('custom extraPatterns', () => {
    const EMAIL = /[\w.]+@[\w.]+\.\w+/

    it('redacts every match of a caller pattern (non-global is treated as global)', () => {
      expect(
        redactSensitiveText('reach me at a@b.com or c@d.org', [EMAIL]),
      ).toBe('reach me at [redacted] or [redacted]')
    })

    it('applies custom patterns on top of built-in credential redaction', () => {
      const result = redactSensitiveText('mail a@b.com key sk-abcdefghijklmnop', [EMAIL])
      expect(result).not.toContain('a@b.com')
      expect(result).not.toContain('sk-abcdefghijklmnop')
    })

    it('does not mutate the caller-supplied pattern', () => {
      const pattern = /x@y\.z/
      redactSensitiveText('x@y.z', [pattern])
      expect(pattern.global).toBe(false)
    })

    it('is a no-op when no extra patterns are supplied', () => {
      expect(redactSensitiveText('reach me at a@b.com')).toBe('reach me at a@b.com')
    })
  })
})

describe('redactSensitiveObject', () => {
  it('redacts string leaves by sensitive key name and token literal', () => {
    const out = redactSensitiveObject({
      password: 'hunter2',
      note: 'token sk-abcdefghijklmnop stored',
      nested: { username: 'alice' },
    })
    expect(out.password).toBe('[redacted]')
    expect(out.note).not.toContain('sk-abcdefghijklmnop')
    expect(out.nested.username).toBe('alice')
  })

  it('forwards extraPatterns to every string leaf', () => {
    const EMAIL = /[\w.]+@[\w.]+\.\w+/
    const out = redactSensitiveObject(
      { contact: 'a@b.com', list: ['c@d.org', 'plain'] },
      [EMAIL],
    )
    expect(out.contact).toBe('[redacted]')
    expect(out.list).toEqual(['[redacted]', 'plain'])
  })
})
