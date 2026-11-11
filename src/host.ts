// The host: an MCP client of both servers and the invoker in SEP-2624 terms.
// Calls a tool on the portal server and audits the result's citations on
// the response phase. Used by the terminal demo, the Claude Code mod, and
// the gateway.
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { listCitations } from './citation-checks.ts';
import {
    discover,
    mutationError,
    newContext,
    runMutators,
    runValidators,
    validationError,
    type MutationSummary,
    type Selected,
    type ValidationSummary
} from './invoker.ts';
import {
    CITATIONS_EXTENSION,
    INTERCEPTORS_EXTENSION,
    type CitedToolResult,
    type Interceptor,
    type InterceptorOverrides,
    type Severity
} from './types.ts';

export type Mode = 'audit' | 'strip' | 'block';

/** Invoker overrides for each mode. `audit` keeps the server-declared defaults. */
export const MODES: Record<Mode, Record<string, InterceptorOverrides>> = {
    audit: {},
    strip: { 'citation-filter': { mode: 'active', timeoutMs: 2000 } },
    block: {
        'citation-url-policy': { mode: 'active' },
        'citation-quote-check': { mode: 'active', timeoutMs: 2000 },
        'citation-license': { mode: 'active' },
        'citation-filter': { mode: 'active', timeoutMs: 2000 }
    }
};

const CONFIG: Record<string, Record<string, unknown>> = {
    // Warn the reader when an answer names no source at all.
    'citation-binding': { uncitedSeverity: 'warn' },
    'citation-url-policy': { allowedSchemes: ['https'] },
    'citation-filter': { allowedSchemes: ['https'] }
};

export interface Host {
    portal: Client;
    interceptorServer: Client;
    interceptors: Interceptor[];
}

export async function connect(script: string, capabilities: Record<string, unknown> = {}, env?: Record<string, string>): Promise<Client> {
    const client = new Client({ name: 'citation-audit-host', version: '0.1.0' }, { capabilities, versionNegotiation: { mode: 'auto' } });
    await client.connect(
        new StdioClientTransport({
            command: process.execPath,
            // Resolved here so the servers start from any working directory.
            args: ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL(script, import.meta.url))],
            ...(env && { env: { ...(process.env as Record<string, string>), ...env } }),
            stderr: 'ignore'
        })
    );
    return client;
}

/** `citations`: the SEP-3094 capability to declare. The default says this client renders citations. */
export async function startHost(citations: Record<string, unknown> = { render: {} }): Promise<Host> {
    const portal = await connect('./portal-server.ts', { extensions: { [CITATIONS_EXTENSION]: citations } });
    const interceptorServer = await connect('./interceptor-server.ts');
    if (!interceptorServer.getServerCapabilities()?.extensions?.[INTERCEPTORS_EXTENSION]) {
        throw new Error(`the Interceptor Server does not declare ${INTERCEPTORS_EXTENSION}`);
    }
    return { portal, interceptorServer, interceptors: await discover(interceptorServer, 'tools/call') };
}

export async function closeHost(host: Host): Promise<void> {
    await host.portal.close();
    await host.interceptorServer.close();
}

export interface Audit {
    /** The result as the portal server returned it. */
    result: CitedToolResult;
    validation: ValidationSummary;
    /** Absent when validation blocked. */
    mutation?: MutationSummary;
    /** The JSON-RPC error the host returns in place of a blocked result. */
    error?: { code: number; message: string; data: unknown };
    /** The result after applied mutations. Absent when blocked. */
    delivered?: CitedToolResult;
}

/** Receiving order from SEP-2624: validate, then mutate only if validation did not block. */
export async function callAndAudit(
    host: Host,
    name: string,
    args: Record<string, unknown>,
    overrides: Record<string, InterceptorOverrides> = {}
): Promise<Audit> {
    const selected: Selected[] = host.interceptors.map(interceptor => ({
        interceptor,
        server: host.interceptorServer,
        overrides: overrides[interceptor.name],
        config: CONFIG[interceptor.name]
    }));

    const result = (await host.portal.callTool({ name, arguments: args })) as CitedToolResult;
    const context = newContext();
    const validation = await runValidators(selected, 'tools/call', 'response', result, context);
    if (validation.blocked) return { result, validation, error: validationError(validation) };

    const mutation = await runMutators(selected, 'tools/call', 'response', result, context);
    if (mutation.failedInterceptor) return { result, validation, mutation, error: mutationError(mutation) };

    return { result, validation, mutation, delivered: mutation.payload as CitedToolResult };
}

export interface Finding {
    interceptor: string;
    severity: Severity;
    path?: string;
    message: string;
}

export interface CitationRow {
    /** The citation's `id`, else its `name`, else its index. */
    key: string;
    name?: string;
    url?: string;
    /** `flagged`: a check reported an error and the citation was not removed. */
    status: 'passed' | 'stripped' | 'flagged';
    quote?: 'verified' | 'not found' | 'unverified';
    /** A short name for the citation's `license`, such as "CC BY 4.0". */
    license?: string;
    /** The publisher or author to credit. */
    credit?: string;
    reasons: string[];
}

export interface AuditReport {
    mode: Mode;
    outcome: 'delivered' | 'blocked';
    /** The content blocks to deliver. Absent when blocked. */
    content?: CitedToolResult['content'];
    /** `reasons`: the errors of the validators that blocked. */
    error?: { code: number; message: string; reasons: string[] };
    citations: CitationRow[];
    findings: Finding[];
}

/** "CC BY-SA 4.0" for a Creative Commons URL, else the value as written. */
function licenseLabel(license: string): string {
    const cc = /creativecommons\.org\/licenses\/([a-z-]+)\/(\d+\.\d+)/i.exec(license);
    return cc ? `CC ${cc[1]!.toUpperCase()} ${cc[2]}` : license;
}

/** A flat report of one audit, for a client that renders the citations. */
export function report(audit: Audit, mode: Mode): AuditReport {
    const findings: Finding[] = audit.validation.outcomes.flatMap(outcome =>
        outcome.result
            ? (outcome.result.messages ?? []).map(message => ({ interceptor: outcome.interceptor, ...message }))
            : [{ interceptor: outcome.interceptor, severity: 'error' as const, message: outcome.failure ?? 'invocation failed' }]
    );
    const applied = audit.mutation?.outcomes.filter(outcome => outcome.applied) ?? [];
    const stripped = new Set(applied.flatMap(outcome => ((outcome.result?.info?.stripped ?? []) as Array<{ index: number }>).map(entry => entry.index)));
    const quoteChecked = audit.validation.outcomes.some(outcome => outcome.interceptor === 'citation-quote-check' && outcome.result);

    const citations = listCitations(audit.result).map(({ index, key, name, url, quote, license, credit }): CitationRow => {
        const own = findings.filter(finding => finding.path?.startsWith(`citations[${index}]`));
        const reasons = own.filter(finding => finding.severity === 'error').map(finding => finding.message);
        const quoteFinding = own.find(finding => finding.path === `citations[${index}].text`);
        return {
            key,
            ...(name && { name }),
            ...(url && { url }),
            status: stripped.has(index) ? 'stripped' : reasons.length > 0 ? 'flagged' : 'passed',
            ...(quote && quoteChecked && { quote: !quoteFinding ? 'verified' : quoteFinding.severity === 'error' ? 'not found' : 'unverified' }),
            ...(license && { license: licenseLabel(license) }),
            ...(credit && { credit }),
            reasons
        };
    });

    const blocking = (audit.error?.data as { validationErrors?: Finding[] } | undefined)?.validationErrors ?? [];

    return {
        mode,
        outcome: audit.delivered ? 'delivered' : 'blocked',
        ...(audit.delivered && { content: audit.delivered.content }),
        ...(audit.error && {
            error: { code: audit.error.code, message: audit.error.message, reasons: blocking.map(entry => `${entry.interceptor}: ${entry.message}`) }
        }),
        citations,
        findings
    };
}
