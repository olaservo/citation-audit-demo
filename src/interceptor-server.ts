// Interceptor Server (SEP-2624): hosts four citation validators and one
// mutator, and nothing else. Serves `interceptors/list` and
// `interceptor/invoke` over stdio.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer, ProtocolError } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import {
    BindingConfigSchema,
    checkBinding,
    checkLicense,
    checkQuotes,
    checkUrlPolicy,
    LicenseConfigSchema,
    QuoteCheckConfigSchema,
    stripBadCitations,
    UrlPolicyConfigSchema,
    type CheckOutput,
    type SourceLookup
} from './citation-checks.ts';
import {
    hookMatches,
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
const HOOK_PHASES = ['request', 'response'] as const;

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

// SEP-2624: configuration and payloads MUST be validated before processing.
const PayloadSchema = z.looseObject({
    content: z.array(z.looseObject({ type: z.string() })).optional(),
    _meta: z.record(z.string(), z.unknown()).optional()
});

/** An interceptor this server hosts. `config` validates the config an invoker sends. */
interface Hosted {
    descriptor: Omit<Interceptor, 'configSchema'>;
    config: z.ZodType<Config>;
    check?: Check;
    mutate?: Mutate;
}

/** The descriptor as advertised, with a `configSchema` generated from `config`. */
function descriptorOf({ descriptor, config }: Hosted): Interceptor {
    // `io: 'input'` describes what an invoker sends, where a field with a default is optional.
    const { $schema: _draft, ...configSchema } = z.toJSONSchema(config, { io: 'input' });
    return { ...descriptor, configSchema: configSchema as Interceptor['configSchema'] };
}

const INTERCEPTORS: Hosted[] = [
    {
        descriptor: {
            name: 'citation-binding',
            version: '0.1.0',
            description: 'Checks that the citations in a tool result\'s `_meta` line up with markers in its text or with the values their pointers name',
            type: 'validation',
            hooks: HOOKS,
            mode: 'audit'
        },
        config: BindingConfigSchema,
        check: checkBinding
    },
    {
        descriptor: {
            name: 'citation-url-policy',
            version: '0.1.0',
            description: 'Rejects citation URLs outside the scheme allow-list or pointing at private, loopback, or link-local addresses',
            type: 'validation',
            hooks: HOOKS,
            mode: 'audit'
        },
        config: UrlPolicyConfigSchema,
        check: checkUrlPolicy
    },
    {
        descriptor: {
            name: 'citation-quote-check',
            version: '0.1.0',
            description: "Checks that each citation's quoted `text` appears in a snapshot of the cited source",
            type: 'validation',
            hooks: HOOKS,
            mode: 'audit',
            // The corpus lookup can fail. An unreadable corpus should not block tool results.
            failOpen: true
        },
        config: QuoteCheckConfigSchema,
        check: (result, config) => checkQuotes(result, lookupSource, config)
    },
    {
        descriptor: {
            name: 'citation-license',
            version: '0.1.0',
            description: 'Checks that each citation carries a `license`, and names a publisher or author when the license requires attribution',
            type: 'validation',
            hooks: HOOKS,
            mode: 'audit'
        },
        config: LicenseConfigSchema,
        check: checkLicense
    },
    {
        descriptor: {
            name: 'citation-filter',
            version: '0.1.0',
            description:
                'Removes citations that fail the binding, URL policy, or quote checks at severity "error", with their markers and link definitions',
            type: 'mutation',
            hooks: HOOKS,
            mode: 'audit',
            // In the recommended range for security sanitization.
            priorityHint: -10000
        },
        // The filter runs the URL policy check, so it takes that check's config.
        config: UrlPolicyConfigSchema,
        mutate: async (result, config) => {
            const { result: payload, stripped } = await stripBadCitations(result, lookupSource, config);
            return { modified: stripped.length > 0, payload, info: { stripped } };
        }
    }
];

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warn: 1, error: 2 };

/**
 * Runs one interceptor and turns what it throws into the SEP's errors. With
 * `timeoutMs` the race answers on time, but the run is not cancelled.
 * SEP-2624 requires cancelling it.
 */
async function withDeadline<T>({ name, phase, timeoutMs }: z.infer<typeof InvokeParamsSchema>, run: () => T | Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        const running = Promise.resolve().then(run);
        if (timeoutMs === undefined) return await running;
        const expired = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ProtocolError(-32000, 'Interceptor execution timeout', { interceptor: name, timeoutMs, phase })), timeoutMs);
        });
        return await Promise.race([running, expired]);
    } catch (error) {
        if (error instanceof ProtocolError) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        throw new ProtocolError(-32603, 'Interceptor execution failed', { interceptor: name, reason });
    } finally {
        clearTimeout(timer);
    }
}

function buildServer(): McpServer {
    const mcp = new McpServer({ name: 'citation-interceptors', version: '0.1.0' });
    mcp.server.registerCapabilities({ extensions: { [INTERCEPTORS_EXTENSION]: { supportedEvents: ['tools/call'] } } });

    mcp.server.setRequestHandler(
        'interceptors/list',
        { params: ListInterceptorsParamsSchema, result: ListInterceptorsResultSchema },
        params => ({
            interceptors: INTERCEPTORS.map(descriptorOf).filter(
                descriptor => !params?.event || HOOK_PHASES.some(phase => hookMatches(descriptor.hooks, params.event!, phase))
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
            if (!hookMatches(entry.descriptor.hooks, params.event, params.phase)) {
                throw new ProtocolError(-32602, `${params.name} does not hook ${params.event} (${params.phase})`, {
                    interceptor: params.name
                });
            }

            // The error shape of the SEP's "Configuration invalid" example.
            const invalid = (what: string, error: z.ZodError) =>
                new ProtocolError(-32603, 'Interceptor execution failed', {
                    interceptor: params.name,
                    reason: `Invalid ${what}: ${z.prettifyError(error)}`
                });
            const parsedConfig = entry.config.safeParse(params.config ?? {});
            if (!parsedConfig.success) throw invalid('config', parsedConfig.error);
            const parsedPayload = PayloadSchema.safeParse(params.payload);
            if (!parsedPayload.success) throw invalid('payload', parsedPayload.error);

            const started = performance.now();
            const payload = parsedPayload.data as CitedToolResult;
            const config = parsedConfig.data;
            const common = { interceptor: params.name, phase: params.phase };

            if (entry.mutate) {
                const mutation = await withDeadline(params, () => entry.mutate!(payload, config));
                return { ...common, type: 'mutation', durationMs: Math.round(performance.now() - started), ...mutation };
            }

            const { messages, info } = await withDeadline(params, () => entry.check!(payload, config));
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
