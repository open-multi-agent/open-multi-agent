/**
 * MCP Notte Tools
 *
 * Connect Notte's MCP server (notte-mcp) over stdio and register all exposed
 * Notte tools — observe, click, fill, scrape, navigate, run agent — as
 * standard open-multi-agent tools. Gives any agent a hosted browser with
 * residential proxies, captcha solving, stealth sessions, and credential
 * vault for authenticated sites.
 *
 * Notte (notte.cc) is hosted browser infrastructure for AI agents:
 *   https://github.com/nottelabs/notte
 *
 * Run:
 *   npx tsx examples/integrations/mcp-notte.ts
 *
 * Prerequisites:
 *   - NOTTE_API_KEY  (get one at https://notte.cc/dashboard)
 *   - GEMINI_API_KEY (or set AGENT_PROVIDER + the matching key)
 *   - uv installed: `brew install uv`  (or `pipx install notte-mcp` and use `notte-mcp` directly)
 *   - @modelcontextprotocol/sdk installed
 */

import { Agent, ToolExecutor, ToolRegistry, registerBuiltInTools } from '../../src/index.js'
import { connectMCPTools } from '../../src/mcp.js'

if (!process.env.NOTTE_API_KEY?.trim()) {
  console.error('Missing NOTTE_API_KEY: get one at https://notte.cc/dashboard and set it in the environment.')
  process.exit(1)
}

const { tools, disconnect } = await connectMCPTools({
  command: 'uvx',
  args: ['notte-mcp'],
  env: {
    ...process.env,
    NOTTE_API_KEY: process.env.NOTTE_API_KEY,
  },
  namePrefix: 'notte',
})

const registry = new ToolRegistry()
registerBuiltInTools(registry)
for (const tool of tools) registry.register(tool)
const executor = new ToolExecutor(registry)

const agent = new Agent(
  {
    name: 'web-researcher',
    model: 'gemini-2.5-flash',
    provider: 'gemini',
    tools: tools.map((tool) => tool.name),
    systemPrompt:
      'Use the Notte browser tools to navigate the live web, scrape pages, and extract structured data. Notte handles anti-bot walls, captchas, and authenticated sessions automatically — prefer it over any built-in HTTP/fetch tool for live-web tasks.',
  },
  registry,
  executor,
)

try {
  const result = await agent.run(
    'Go to news.ycombinator.com and return the top 5 posts as JSON with title, url, and points.',
  )

  console.log(result.output)
} finally {
  await disconnect()
}
