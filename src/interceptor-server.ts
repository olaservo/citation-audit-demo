// Interceptor Server (SEP-2624): hosts four citation validators and one
// mutator, and nothing else. Serves `interceptors/list` and
// `interceptor/invoke` over stdio.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer, ProtocolError } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import { checkBinding, checkLicense, checkQuotes, checkUrlPolicy, stripBadCitations, type CheckOutput, type SourceLookup } from './citation-checks.ts';
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

// SEP-2624: configuration and payloads MUST be validated before processing.
// Each `config` enforces the `configSchema` its descriptor advertises.
const BindingConfig = z.strictObject({ uncitedSeverity: z.enum(['info', 'warn', 'error']).optional() });
const SchemesConfig = z.strictObject({ allowedSchemes: z.array(z.string()).optional() });
const QuoteConfig = z.strictObject({ unverifiedSeverity: z.enum(['info', 'warn', 'error']).optional() });
const LicenseConfig = z.strictObject({ missingSeverity: z.enum(['info', 'warn', 'error']).optional() });
const PayloadSchema = z.looseObject({ content: z.array(z.looseObject({ type: z.string() })).optional() });

const INTERCEPTORS: Array<{ descriptor: Interceptor; config: z.ZodType<Config>; check?: Check; mutate?: Mutate }> = [
    {
        descriptor: {
            name: 'citation-binding',
            version: '0.1.0',
            description: 'Checks that citation markers in tool result text and entries in `citations` line up (SEP-3094)',
            type: 'validation',
            hooks: HOOKS,
            mode: 'audit',
            configSchema: {
                type: 'object',
                properties: { uncitedSeverity: { type: 'string', enum: ['info', 'warn', 'error'] } },
                additionalProperties: false
            }
        },
        config: BindingConfig,
        check: (result, config) => checkBinding(result, config)
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
        config: SchemesConfig,
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
        config: QuoteConfig,
        check: (result, config) => checkQuotes(result, lookupSource, config)
    },
    {
        descriptor: {
            name: 'citation-license',
            version: '0.1.0',
            description: 'Checks that each citation carries a `license`, and names a publisher or author when the license requires attribution',
            type: 'validation',
            hooks: HOOKS,
            mode: 'audit',
            configSchema: {
                type: 'object',
                properties: { missingSeverity: { type: 'string', enum: ['info', 'warn', 'error'], default: 'error' } },
                additionalProperties: false
            }
        },
        config: LicenseConfig,
        check: (result, config) => checkLicense(result, config)
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
        config: SchemesConfig,
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

            const invalid = (what: string, error: z.ZodError) =>
                new ProtocolError(-32602, `Invalid ${what} for ${params.name}`, { interceptor: params.name, reason: z.prettifyError(error) });
            const parsedConfig = entry.config.safeParse(params.config ?? {});
            if (!parsedConfig.success) throw invalid('config', parsedConfig.error);
            const parsedPayload = PayloadSchema.safeParse(params.payload);
            if (!parsedPayload.success) throw invalid('payload', parsedPayload.error);

            const started = performance.now();
            const payload = parsedPayload.data as CitedToolResult;
            const config = parsedConfig.data;
            const { timeoutMs } = params;
            // The race answers on time. It does not cancel the check, which the SEP requires.
            const deadline = async <T>(run: () => T | Promise<T>): Promise<T> => {
                try {
                    const running = Promise.resolve().then(run);
                    return await (timeoutMs === undefined ? running : Promise.race([running, timeout(params.name, params.phase, timeoutMs)]));
                } catch (error) {
                    if (error instanceof ProtocolError) throw error;
                    const reason = error instanceof Error ? error.message : String(error);
                    throw new ProtocolError(-32603, 'Interceptor execution failed', { interceptor: params.name, reason });
                }
            };
            const common = { interceptor: params.name, phase: params.phase };

            if (entry.mutate) {
                const mutation = await deadline(() => entry.mutate!(payload, config));
                return { ...common, type: 'mutation', durationMs: Math.round(performance.now() - started), ...mutation };
            }

            const { messages, info } = await deadline(() => entry.check!(payload, config));
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
