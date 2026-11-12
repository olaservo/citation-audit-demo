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
    text?: string;
    description?: string;
    thumbnailUrl?: string;
    datePublished?: string;
    author?: unknown;
    publisher?: unknown;
    /** schema.org CreativeWork `license`: a URL or a name. Not in the SEP's subset. */
    license?: string;
    display?: 'embedded' | 'external' | 'auto';
}

// A tools/call result carrying SEP-3094 citations. This is the payload the
// citation interceptors receive on the response phase.
export interface CitedToolResult {
    content?: Array<{ type: string; text?: string }>;
    citations?: unknown;
}
