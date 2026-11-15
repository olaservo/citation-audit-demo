// A probe MCP server. Each tool returns a different marker in each part of
// its result, so a run shows which parts a client passes on.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const parts = {
    content: [{ type: 'text' as const, text: 'MARK_CONTENT_TEXT', _meta: { probe: 'MARK_BLOCK_META' } }],
    _meta: { probe: 'MARK_RESULT_META' },
    // Not in the MCP schema. SEP-3094 proposes it.
    citations: [{ name: 'MARK_TOP_LEVEL' }]
};

function buildServer(): McpServer {
    const mcp = new McpServer({ name: 'probe', version: '0.1.0' });
    mcp.registerTool('plain', { description: 'Returns a probe result with content blocks only', inputSchema: {} }, () => parts);
    mcp.registerTool(
        'structured',
        { description: 'Returns a probe result that also has structuredContent', inputSchema: {}, outputSchema: { marker: z.string() } },
        () => ({ ...parts, structuredContent: { marker: 'MARK_STRUCTURED' } })
    );
    return mcp;
}

void serveStdio(buildServer);
