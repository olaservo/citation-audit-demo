// Interceptor Server (SEP-2624): hosts three citation validators and one
// mutator, and nothing else. Serves `interceptors/list` and
// `interceptor/invoke` over stdio.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer, ProtocolError } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { checkBinding, checkQuotes, checkUrlPolicy, stripBadCitations, type CheckOutput, type SourceLookup } from './citation-checks.ts';
import {
    INTERCEPTORS_EXTENSION,
    InvokeParamsSchema,
    InvokeResultSchema,
    ListInterceptorsParamsSchema,
    ListInterceptorsResultSchema,
    type CitedToolResult,
    type Hook,
    type Interceptor,
    type MutationResult,
    type Severity,
    type ValidationResult
} from './types.ts';

const HOOKS: Hook[] = [{ events: ['tools/call'], phase: 'response' }];

// Snapshots of cited sources, keyed by URL in corpus/index.json. A deployed
// auditor would fetch sources under the SEP-3094 dereferencing rules.
const corpusDir = process.env.CITATION_CORPUS ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus');

const lookupSource: SourceLookup = async url => {
    const index = JSON.parse(await readFile(join(corpusDir, 'index.json'), 'utf8')) as Record<string, string>;
    const file = index[url];
    return file ? readFile(join(corpusDir, file), 'utf8') : undefined;
};

type Config = Record<string, unknown>;
type Check = (result: CitedToolResult, config: Config) => CheckOutput | Promise<CheckOutput>;
type Mutate = (result: CitedToolResult, config: Config) => Promise<Pick<MutationResult, 'modified' | 'payload' | 'info'>>;

const ALLOWED_SCHEMES = { type: 'array', items: { type: 'string' }, default: ['https'] };

const INTERCEPTORS: Array<{ descriptor: Interceptor; check?: Check; mutate?: Mutate }> = [
    {
        descriptor: {
            name: 'citation-binding',
            version: '0.1.0',
            description: 'Checks that citation markers in tool result text and entries in `citations` line up (SEP-3094)',
            type: 'validation',
            hooks: HOOKS,
            mode: 'audit',
            configSchema: { type: 'object', additionalProperties: false }
        },
        check: result => checkBinding(result)
    },
    {
        descriptor: {
            name: 'citation-url-policy',
            version: '0.1.0',
            description: 'Rejects citation URLs outside the scheme allow-list or pointing at private, loopback, or link-local addresses',
            type: 'validation',
            hooks: HOOKS,
            mode: 'audit',
            configSchema: { type: 'object', properties: { allowedSchemes: ALLOWED_SCHEMES }, additionalProperties: false }
        },
        check: (result, config) => checkUrlPolicy(result, config)
    },
    {
        descriptor: {
            name: 'citation-quote-check',
            version: '0.1.0',
            description: "Checks that each citation's quoted `text` appears in a snapshot of the cited source",
            type: 'validation',
            hooks: HOOKS,
            mode: 'audit',
            // The corpus lookup can fail; an unreadable corpus should not block tool results.
            failOpen: true,
            configSchema: {
                type: 'object',
                properties: { unverifiedSeverity: { type: 'string', enum: ['info', 'warn', 'error'], default: 'info' } },
                additionalProperties: false
            }
        },
        check: (result, config) => checkQuotes(result, lookupSource, config)
    },
    {
        descriptor: {
            name: 'citation-stripper',
            version: '0.1.0',
            description:
                'Removes citations that fail the binding, URL policy, or quote checks at severity "error", with their markers and link definitions',
            type: 'mutation',
            hooks: HOOKS,
            mode: 'audit',
            // In the recommended range for security sanitization.
            priorityHint: -10000,
            configSchema: { type: 'object', properties: { allowedSchemes: ALLOWED_SCHEMES }, additionalProperties: false }
        },
        mutate: async (result, config) => {
            const { result: payload, stripped } = await stripBadCitations(result, lookupSource, config);
            return { modified: stripped.length > 0, payload, info: { stripped } };
        }
    }
];

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warn: 1, error: 2 };

function matches(hooks: Hook[], event: string, phase: string): boolean {
    return hooks.some(hook => hook.phase === phase && (hook.events.includes(event) || hook.events.includes('*')));
}

function timeout(name: string, phase: string, timeoutMs: number): Promise<never> {
    return new Promise((_, reject) => {
        const timer = setTimeout(
            () => reject(new ProtocolError(-32000, 'Interceptor execution timeout', { interceptor: name, timeoutMs, phase })),
            timeoutMs
        );
        timer.unref();
    });
}

function buildServer(): McpServer {
    const mcp = new McpServer({ name: 'citation-interceptors', version: '0.1.0' });
    mcp.server.registerCapabilities({ extensions: { [INTERCEPTORS_EXTENSION]: { supportedEvents: ['tools/call'] } } });

    mcp.server.setRequestHandler(
        'interceptors/list',
        { params: ListInterceptorsParamsSchema, result: ListInterceptorsResultSchema },
        params => ({
            interceptors: INTERCEPTORS.map(entry => entry.descriptor).filter(
                descriptor => !params?.event || descriptor.hooks.some(hook => hook.events.includes(params.event!) || hook.events.includes('*'))
            )
        })
    );

    mcp.server.setRequestHandler(
        'interceptor/invoke',
        { params: InvokeParamsSchema, result: InvokeResultSchema },
        async (params): Promise<ValidationResult | MutationResult> => {
            const entry = INTERCEPTORS.find(candidate => candidate.descriptor.name === params.name);
            if (!entry) {
                throw new ProtocolError(-32602, `Unknown interceptor: ${params.name}`, { interceptor: params.name });
            }
            if (!matches(entry.descriptor.hooks, params.event, params.phase)) {
                throw new ProtocolError(-32602, `${params.name} does not hook ${params.event} (${params.phase})`, {
                    interceptor: params.name
                });
            }

            const started = performance.now();
            const payload = (params.payload ?? {}) as CitedToolResult;
            const config = params.config ?? {};
            const deadline = <T>(run: Promise<T>): Promise<T> =>
                params.timeoutMs ? Promise.race([run, timeout(params.name, params.phase, params.timeoutMs)]) : run;
            const common = { interceptor: params.name, phase: params.phase };

            if (entry.mutate) {
                const mutation = await deadline(entry.mutate(payload, config));
                return { ...common, type: 'mutation', durationMs: Math.round(performance.now() - started), ...mutation };
            }

            const { messages, info } = await deadline(Promise.resolve(entry.check!(payload, config)));
            const worst = messages.reduce<Severity | undefined>(
                (top, message) => (top === undefined || SEVERITY_RANK[message.severity] > SEVERITY_RANK[top] ? message.severity : top),
                undefined
            );
            return {
                ...common,
                type: 'validation',
                durationMs: Math.round(performance.now() - started),
                info,
                valid: worst !== 'error',
                ...(worst && { severity: worst }),
                messages
            };
        }
    );

    return mcp;
}

void serveStdio(buildServer);
console.error('[citation-interceptors] serving over stdio');
