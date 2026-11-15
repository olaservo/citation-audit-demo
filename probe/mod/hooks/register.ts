import type { Register } from 'claude-code'

// Writes what a mod receives for each probe call to probe/out, for probe/run.ts to read.
export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    if (!e.tool.startsWith('mcp__probe__')) return next(e)
    const name = e.tool.replace('mcp__probe__', '')
    const hookResult = await next(e)
    const mcpCall = await $.mcp.call('probe', name, {})
    await $.fs.write(`probe/out/mod-${name}.json`, JSON.stringify({ hookResult, mcpCall }, null, 2))
    return hookResult
  })
}
