// What a client declared for citations, read the way the server SDK documents
// for both protocol eras.
import { CLIENT_CAPABILITIES_META_KEY, type ClientCapabilities, type McpServer, type ServerContext } from '@modelcontextprotocol/server';

import { CITATIONS_EXTENSION } from './types.ts';

/**
 * The client's citations capability, or undefined if it declared none.
 * Capabilities arrive per request on 2026-07-28 and from `initialize` before that.
 */
export function citationsCapability(mcp: McpServer, ctx: ServerContext): { render?: unknown } | undefined {
    const envelope = ctx.mcpReq.envelope as Record<string, ClientCapabilities | undefined> | undefined;
    const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? mcp.server.getClientCapabilities();
    return capabilities?.extensions?.[CITATIONS_EXTENSION] as { render?: unknown } | undefined;
}
