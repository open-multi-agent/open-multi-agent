import { describe, expect, it } from 'vitest'
import { renderTeamRunDashboard } from '../src/dashboard/render-team-run-dashboard.js'

describe('renderTeamRunDashboard', () => {
  it('does not embed unescaped script terminators in the JSON payload and keeps XSS payloads out of HTML markup', () => {
    const malicious = '"</script><img src=x onerror=alert(1)>"'
    const html = renderTeamRunDashboard({
      success: true,
      goal: 'safe-goal',
      tasks: [
        {
          id: 't1',
          title: malicious,
          status: 'pending',
          dependsOn: [],
        },
      ],
      agentResults: new Map(),
      totalTokenUsage: { input_tokens: 0, output_tokens: 0 },
    })

    const dataOpen = 'id="oma-data">'
    const start = html.indexOf(dataOpen)
    expect(start).toBeGreaterThan(-1)
    const contentStart = start + dataOpen.length
    const end = html.indexOf('</script>', contentStart)
    expect(end).toBeGreaterThan(contentStart)
    const jsonSlice = html.slice(contentStart, end)
    expect(jsonSlice.toLowerCase()).not.toContain('</script')

    const parsed = JSON.parse(jsonSlice) as { tasks: { title: string }[] }
    expect(parsed.tasks[0]!.title).toBe(malicious)

    const beforeData = html.slice(0, start)
    expect(beforeData).not.toContain(malicious)
    expect(beforeData.toLowerCase()).not.toMatch(/\sonerror\s*=/)
  })

  it('keeps task description text in JSON payload', () => {
    const description = 'danger: </script><svg onload=alert(1)>'
    const html = renderTeamRunDashboard({
      success: true,
      goal: 'safe-goal',
      tasks: [
        {
          id: 't1',
          title: 'task',
          description,
          status: 'pending',
          dependsOn: [],
        } as { id: string; title: string; description: string; status: 'pending'; dependsOn: string[] },
      ],
      agentResults: new Map(),
      totalTokenUsage: { input_tokens: 0, output_tokens: 0 },
    })

    const start = html.indexOf('id="oma-data">')
    const contentStart = start + 'id="oma-data">'.length
    const end = html.indexOf('</script>', contentStart)
    const parsed = JSON.parse(html.slice(contentStart, end)) as {
      tasks: Array<{ description?: string }>
    }
    expect(parsed.tasks[0]!.description).toBe(description)
  })

  it('keeps task result text in JSON payload', () => {
    const result = 'final output </script><img src=x onerror=alert(1)>'
    const html = renderTeamRunDashboard({
      success: true,
      goal: 'safe-goal',
      tasks: [
        {
          id: 't1',
          title: 'task',
          result,
          status: 'completed',
          dependsOn: [],
        } as { id: string; title: string; result: string; status: 'completed'; dependsOn: string[] },
      ],
      agentResults: new Map(),
      totalTokenUsage: { input_tokens: 0, output_tokens: 0 },
    })

    const start = html.indexOf('id="oma-data">')
    const contentStart = start + 'id="oma-data">'.length
    const end = html.indexOf('</script>', contentStart)
    const parsed = JSON.parse(html.slice(contentStart, end)) as {
      tasks: Array<{ result?: string }>
    }
    expect(parsed.tasks[0]!.result).toBe(result)
  })

  it('does not reference remote dashboard assets', () => {
    const html = renderTeamRunDashboard({
      success: true,
      goal: 'safe-goal',
      tasks: [],
      agentResults: new Map(),
      totalTokenUsage: { input_tokens: 0, output_tokens: 0 },
    })

    expect(html).not.toMatch(/<script[^>]+src=/i)
    expect(html).not.toMatch(/<link[^>]+href=/i)
    expect(html).not.toContain('cdn.tailwindcss.com')
    expect(html).not.toContain('fonts.googleapis.com')
  })

  it('redacts sensitive-looking values from the embedded JSON payload', () => {
    const secret = 'sk-dashboardsecretvalue1234567890'
    const html = renderTeamRunDashboard({
      success: true,
      goal: 'password=hunter2',
      tasks: [
        {
          id: 't1',
          title: 'task',
          description: `OPENAI_API_KEY=${secret}`,
          result: `Authorization: Bearer ${secret}`,
          status: 'completed',
          dependsOn: [],
        } as { id: string; title: string; description: string; result: string; status: 'completed'; dependsOn: string[] },
      ],
      agentResults: new Map(),
      totalTokenUsage: { input_tokens: 0, output_tokens: 0 },
    })

    const start = html.indexOf('id="oma-data">')
    const contentStart = start + 'id="oma-data">'.length
    const end = html.indexOf('</script>', contentStart)
    const parsed = JSON.parse(html.slice(contentStart, end)) as {
      goal: string
      tasks: Array<{ description?: string; result?: string }>
    }

    expect(html).not.toContain(secret)
    expect(parsed.goal).toBe('password=[redacted]')
    expect(parsed.tasks[0]!.description).toBe('OPENAI_API_KEY=[redacted]')
    expect(parsed.tasks[0]!.result).toBe('Authorization: [redacted]')
  })
})
