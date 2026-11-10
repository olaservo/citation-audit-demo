// A sample MCP server whose `research` tool returns SEP-3094 citations.
// The `severance` topic returns flawed citations on purpose, so the auditor
// has something to find.
import { CLIENT_CAPABILITIES_META_KEY, McpServer, type ClientCapabilities } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import { CITATIONS_EXTENSION, type Citation } from './types.ts';

interface Answer {
    text: string;
    citations: Citation[];
}

const MARBURY = 'https://www.law.cornell.edu/supremecourt/text/5/137';
const HANDBOOK = 'https://handbook.example.com/employee-handbook';

const ANSWERS: Record<string, Answer> = {
    // Uses all three link forms from the SEP: a bare marker, a marker whose
    // citation carries a text-fragment URL, and an inline link keyed by `name`.
    'judicial-review': {
        text: [
            'Judicial review in the United States traces to [Marbury v. Madison, 5 U.S. (1 Cranch) 137 (1803)](' + MARBURY + ').',
            'The Court held that it is "emphatically the province and duty of the judicial department to say what the law is" [c1],',
            'and that a law repugnant to the constitution is void [c2].',
            '',
            `[c1]: ${MARBURY}`,
            `[c2]: ${MARBURY}`
        ].join('\n'),
        citations: [
            {
                id: 'c1',
                text: 'It is emphatically the province and duty of the judicial department to say what the law is.'
            },
            {
                id: 'c2',
                url: `${MARBURY}#:~:text=a%20law%20repugnant%20to%20the%20constitution%20is%20void`,
                text: 'a law repugnant to the constitution is void'
            },
            {
                name: 'Marbury v. Madison, 5 U.S. (1 Cranch) 137 (1803)',
                description: "The Supreme Court decision that established the federal judiciary's power to strike down laws repugnant to the Constitution.",
                datePublished: '1803-02-24'
            }
        ]
    },

    severance: {
        text: [
            'An employee terminated without cause receives four weeks of severance for each year of service [c1].',
            'Severance is doubled after ten years of service [c2].',
            'Payment is made within 30 days [c3].',
            'Payment dates are listed on the HR portal [c4].',
            '',
            `[c1]: ${HANDBOOK}#section-4-termination`,
            `[c2]: ${HANDBOOK}#section-4-termination`,
            '[c4]: http://169.254.169.254/latest/meta-data/'
        ].join('\n'),
        citations: [
            // Sound: the quote is in the handbook.
            {
                id: 'c1',
                name: 'Employee Handbook',
                text: 'An employee terminated without cause receives four weeks of severance for each year of service.'
            },
            // The handbook says nothing like this.
            {
                id: 'c2',
                name: 'Employee Handbook',
                text: 'Severance is doubled for employees with more than ten years of service.'
            },
            // [c3] has no entry here and no link definition above.
            // Link-local destination and a file: thumbnail.
            { id: 'c4', name: 'HR portal', thumbnailUrl: 'file:///etc/passwd' },
            // No [c5] marker in the text.
            { id: 'c5', name: 'Payroll calendar', url: 'https://payroll.example.com/calendar' },
            // None of id, name, or url.
            { description: 'Internal memo on severance policy' }
        ]
    }
};

function buildServer(): McpServer {
    const mcp = new McpServer({ name: 'research-server', version: '0.1.0' });

    mcp.registerTool(
        'research',
        {
            description: 'Answers a research question with citations',
            inputSchema: { topic: z.enum(['judicial-review', 'severance']) }
        },
        ({ topic }, ctx) => {
            const answer = ANSWERS[topic]!;
            // SEP-3094: omit `citations` when the client did not declare support.
            // Capabilities arrive per request on 2026-07-28 and from `initialize` before that.
            const envelope = ctx.mcpReq.envelope as Record<string, ClientCapabilities | undefined> | undefined;
            const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? mcp.server.getClientCapabilities();
            const declared = capabilities?.extensions?.[CITATIONS_EXTENSION] !== undefined;
            return {
                content: [{ type: 'text', text: answer.text }],
                ...(declared && { citations: answer.citations })
            };
        }
    );

    return mcp;
}

void serveStdio(buildServer);
console.error('[research-server] serving over stdio');
