// Wire types from SEP-2624 (docs/sep.md at 07c89a2) and SEP-3094.
import { z } from 'zod';

export const INTERCEPTORS_EXTENSION = 'io.modelcontextprotocol/interceptors';

// SEP-3094 puts `citations` at the top level of clientCapabilities. The SDK
// drops capability keys it does not know, so the demo declares it as an
// extension capability with the same value.
export const CITATIONS_EXTENSION = 'io.modelcontextprotocol/citations';

export type Phase = 'request' | 'response';
export type Severity = 'info' | 'warn' | 'error';
export type Mode = 'active' | 'audit';

export type PriorityHint = number | { request?: number; response?: number };

export interface Hook {
    events: string[];
    phase: Phase;
}

/** Whether any hook covers the event on the phase. `"*"` matches every event. */
export function hookMatches(hooks: Hook[], event: string, phase: string): boolean {
    return hooks.some(hook => hook.phase === phase && (hook.events.includes(event) || hook.events.includes('*')));
}

// Type aliases, so they are assignable to the loose zod schemas below.
export type Interceptor = {
    name: string;
    version?: string;
    description?: string;
    type: 'validation' | 'mutation';
    hooks: Hook[];
    mode?: Mode;
    failOpen?: boolean;
    priorityHint?: PriorityHint;
    configSchema?: {
        type: 'object';
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
    };
};

export interface ValidationMessage {
    path?: string;
    message: string;
    severity: Severity;
}

export type ValidationResult = {
    interceptor: string;
    type: 'validation';
    phase: Phase;
    durationMs?: number;
    info?: Record<string, unknown>;
    valid: boolean;
    severity?: Severity;
    messages?: ValidationMessage[];
};

export type MutationResult = {
    interceptor: string;
    type: 'mutation';
    phase: Phase;
    durationMs?: number;
    info?: Record<string, unknown>;
    modified: boolean;
    payload: unknown;
};

export interface InterceptorOverrides {
    failOpen?: boolean;
    priorityHint?: PriorityHint;
    mode?: Mode;
    timeoutMs?: number;
    hooks?: Hook[];
}

const PhaseSchema = z.enum(['request', 'response']);
const SeveritySchema = z.enum(['info', 'warn', 'error']);

export const ListInterceptorsParamsSchema = z.object({ event: z.string().optional() }).optional();

export const InterceptorSchema = z.looseObject({
    name: z.string(),
    type: z.enum(['validation', 'mutation']),
    hooks: z.array(z.object({ events: z.array(z.string()), phase: PhaseSchema })),
    mode: z.enum(['active', 'audit']).optional(),
    failOpen: z.boolean().optional()
});

export const ListInterceptorsResultSchema = z.looseObject({ interceptors: z.array(InterceptorSchema) });

export const InvokeParamsSchema = z.object({
    name: z.string(),
    event: z.string(),
    phase: PhaseSchema,
    payload: z.unknown(),
    config: z.record(z.string(), z.unknown()).optional(),
    timeoutMs: z.number().optional(),
    context: z.looseObject({ timestamp: z.string() }).optional()
});

export const ValidationResultSchema = z.looseObject({
    interceptor: z.string(),
    type: z.literal('validation'),
    phase: PhaseSchema,
    durationMs: z.number().optional(),
    info: z.record(z.string(), z.unknown()).optional(),
    valid: z.boolean(),
    severity: SeveritySchema.optional(),
    messages: z.array(z.object({ path: z.string().optional(), message: z.string(), severity: SeveritySchema })).optional()
});

export const MutationResultSchema = z.looseObject({
    interceptor: z.string(),
    type: z.literal('mutation'),
    phase: PhaseSchema,
    durationMs: z.number().optional(),
    info: z.record(z.string(), z.unknown()).optional(),
    modified: z.boolean(),
    payload: z.unknown()
});

export const InvokeResultSchema = z.union([ValidationResultSchema, MutationResultSchema]);

// SEP-3094 citation: the commonly used subset of schema.org CreativeWork.
export interface Citation {
    id?: string;
    name?: string;
    url?: string;
    /** A JSON Pointer (RFC 6901) to the part of the result the citation supports. Not in SEP-3094. */
    pointer?: string;
    text?: string;
    description?: string;
    thumbnailUrl?: string;
    datePublished?: string;
    author?: unknown;
    publisher?: unknown;
    /** schema.org CreativeWork `license`: a URL or a name. Not in the SEP's subset. */
    license?: string;
    display?: 'embedded' | 'external' | 'auto';
    /** SEP-3094 also puts `audience` here. The demo leaves it out. */
    'mcp:annotations'?: { priority?: number; lastModified?: string };
}

// The `_meta` key of a tools/call result that holds its citations. SEP-3094
// proposes a top-level `citations` field. The demo follows the alternative
// its author raised: `_meta`, read by interceptors.
export const CITATIONS_META_KEY = CITATIONS_EXTENSION;

/** The path of the citations in a result, for validation messages. */
export const CITATIONS_PATH = `_meta["${CITATIONS_META_KEY}"]`;

// A tools/call result carrying citations. This is the payload the citation
// interceptors receive on the response phase. `content` is what the model
// reads. `_meta` stays with the host.
export interface CitedToolResult {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
    _meta?: Record<string, unknown>;
}

/** The text the model reads. In the current result shape that is the text blocks of `content`. */
export function textOf(result: CitedToolResult): string {
    return (Array.isArray(result.content) ? result.content : [])
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n\n');
}

/** The result with each piece of that text rewritten. */
export function mapText(result: CitedToolResult, rewrite: (text: string) => string): CitedToolResult {
    if (!Array.isArray(result.content)) return result;
    return {
        ...result,
        content: result.content.map(block => (block.type === 'text' && typeof block.text === 'string' ? { ...block, text: rewrite(block.text) } : block))
    };
}

/** The value at the citations key, which may be malformed. */
export function citationsOf(result: CitedToolResult): unknown {
    return result._meta?.[CITATIONS_META_KEY];
}

/** The result with its citations replaced, or removed when `citations` is undefined. Other `_meta` keys are kept. */
export function withCitations(result: CitedToolResult, citations?: unknown[]): CitedToolResult {
    const { _meta, ...rest } = result;
    const { [CITATIONS_META_KEY]: _dropped, ...meta } = _meta ?? {};
    if (citations !== undefined) meta[CITATIONS_META_KEY] = citations;
    return Object.keys(meta).length > 0 ? { ...rest, _meta: meta } : rest;
}
