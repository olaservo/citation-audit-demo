// A gateway: an MCP server to its client, and the invoker in SEP-2624 terms
// toward the portal server and the Interceptor Server. It audits every
// tools/call result before passing it on, so the client needs no interceptor
// support. GATEWAY_MODE is audit, strip (the default), or block.
import { McpServer, ProtocolError, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { citationsCapability } from './client-capabilities.ts';
import { callAndAudit, MODES, report, startHost, type AuditMode, type Host } from './host.ts';
import { withCitations } from './types.ts';

const mode = (process.env.GATEWAY_MODE ?? 'strip') as AuditMode;
if (!(mode in MODES)) throw new Error(`unknown GATEWAY_MODE "${mode}": expected ${Object.keys(MODES).join(', ')}`);

// The gateway reads citations and draws nothing, so it declares the
// capability to the portal server without `render`.
let host: Promise<Host> | undefined;
const upstream = () => (host ??= startHost({}));

function buildServer(): McpServer {
    const mcp = new McpServer({ name: 'citation-gateway', version: '0.1.0' });
    mcp.server.registerCapabilities({ tools: {} });

    mcp.server.setRequestHandler('tools/list', async request => (await upstream()).portal.listTools(request.params));

    mcp.server.setRequestHandler('tools/call', async (request, ctx): Promise<CallToolResult> => {
        const { name, arguments: args = {} } = request.params;
        const audit = await callAndAudit(await upstream(), name, args, MODES[mode]);

        const { outcome, citations, findings } = report(audit, mode);
        const count = (status: string) => citations.filter(citation => citation.status === status).length;
        console.error(`[gateway] ${name} ${mode} ${outcome}: ${count('passed')} passed, ${count('stripped')} stripped, ${count('flagged')} flagged`);
        for (const finding of findings) console.error(`[gateway]   ${finding.severity} ${finding.interceptor} ${finding.path ?? ''} ${finding.message}`);

        if (!audit.delivered) throw new ProtocolError(audit.error!.code, audit.error!.message, audit.error!.data);

        // SEP-3094 applied at this hop: omit the citations for a client that did not declare support.
        const delivered = citationsCapability(mcp, ctx) ? audit.delivered : withCitations(audit.delivered);
        return delivered as CallToolResult;
    });

    return mcp;
}

void serveStdio(buildServer);
console.error(`[gateway] serving over stdio, mode ${mode}`);
