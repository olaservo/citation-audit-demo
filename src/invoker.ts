// Invoker-side orchestration from SEP-2624 "Executing Multiple Interceptors":
// discover, resolve policy, then validate in parallel and mutate in sequence.
import type { Client } from '@modelcontextprotocol/client';

import {
    ListInterceptorsResultSchema,
    MutationResultSchema,
    ValidationResultSchema,
    type Hook,
    type Interceptor,
    type InterceptorOverrides,
    type Mode,
    type MutationResult,
    type Phase,
    type ValidationResult
} from './types.ts';

/** A discovered interceptor, the server that advertised it, and the invoker's policy for it. */
export interface Selected {
    interceptor: Interceptor;
    server: Client;
    overrides?: InterceptorOverrides;
    config?: Record<string, unknown>;
}

/** Resolved policy for one invocation, with where each value came from. */
interface Policy {
    interceptor: string;
    mode: Mode;
    modeSource: 'override' | 'default';
    failOpen: boolean;
    failOpenSource: 'override' | 'default';
    /** Set when the invocation itself failed (crash, timeout, transport error). */
    failure?: string;
}

export interface ValidationOutcome extends Policy {
    result?: ValidationResult;
    blocks: boolean;
}

export interface ValidationSummary {
    outcomes: ValidationOutcome[];
    blocked: boolean;
}

export interface MutationOutcome extends Policy {
    priority: number;
    result?: MutationResult;
    /** False for shadow mutations (audit mode) and for failures. */
    applied: boolean;
}

export interface MutationSummary {
    outcomes: MutationOutcome[];
    /** The payload after all applied mutations, or the original if any mutation halted. */
    payload: unknown;
    /** The interceptor whose failure halted execution, if any. */
    failedInterceptor?: string;
}

export async function discover(server: Client, event?: string): Promise<Interceptor[]> {
    const result = await server.request({ method: 'interceptors/list', params: event ? { event } : {} }, ListInterceptorsResultSchema);
    return result.interceptors as Interceptor[];
}

function hookMatches(hooks: Hook[], event: string, phase: Phase): boolean {
    return hooks.some(hook => hook.phase === phase && (hook.events.includes(event) || hook.events.includes('*')));
}

/** Override hooks may narrow the declared hooks and MUST NOT widen them. */
function assertNarrowing(interceptor: Interceptor, overrides: Hook[]): void {
    for (const hook of overrides) {
        for (const event of hook.events) {
            if (!hookMatches(interceptor.hooks, event, hook.phase)) {
                throw new Error(`override for ${interceptor.name} widens hooks: ${event} (${hook.phase}) is not declared`);
            }
        }
    }
}

function applicable(selected: Selected[], type: Interceptor['type'], event: string, phase: Phase): Selected[] {
    return selected.filter(({ interceptor, overrides }) => {
        if (interceptor.type !== type) return false;
        if (overrides?.hooks) assertNarrowing(interceptor, overrides.hooks);
        return hookMatches(overrides?.hooks ?? interceptor.hooks, event, phase);
    });
}

function resolvePolicy({ interceptor, overrides }: Selected): Policy {
    return {
        interceptor: interceptor.name,
        mode: overrides?.mode ?? interceptor.mode ?? 'active',
        modeSource: overrides?.mode ? 'override' : 'default',
        failOpen: overrides?.failOpen ?? interceptor.failOpen ?? false,
        failOpenSource: overrides?.failOpen === undefined ? 'default' : 'override'
    };
}

/** SEP-2624 "Priority Resolution". */
function resolvePriority({ interceptor, overrides }: Selected, phase: Phase): number {
    const hint = overrides?.priorityHint ?? interceptor.priorityHint;
    if (hint === undefined) return 0;
    if (typeof hint === 'number') return hint;
    return hint[phase] ?? 0;
}

function invokeParams({ interceptor, overrides, config }: Selected, event: string, phase: Phase, payload: unknown, context: object) {
    return {
        name: interceptor.name,
        event,
        phase,
        payload,
        ...(config && { config }),
        ...(overrides?.timeoutMs && { timeoutMs: overrides.timeoutMs }),
        context
    };
}

function newContext() {
    return { timestamp: new Date().toISOString(), traceId: crypto.randomUUID() };
}

/** Validations run in parallel. Only severity "error" blocks, and only in active mode. */
export async function runValidators(selected: Selected[], event: string, phase: Phase, payload: unknown): Promise<ValidationSummary> {
    const context = newContext();
    const outcomes = await Promise.all(
        applicable(selected, 'validation', event, phase).map(async (entry): Promise<ValidationOutcome> => {
            const outcome: ValidationOutcome = { ...resolvePolicy(entry), blocks: false };
            try {
                const request = { method: 'interceptor/invoke', params: invokeParams(entry, event, phase, payload, context) };
                const result = await entry.server.request(request, ValidationResultSchema);
                outcome.result = result as ValidationResult;
                const hasError = result.severity === 'error' || (result.messages ?? []).some(message => message.severity === 'error');
                outcome.blocks = outcome.mode === 'active' && hasError;
            } catch (error) {
                outcome.failure = error instanceof Error ? error.message : String(error);
                outcome.blocks = outcome.mode === 'active' && !outcome.failOpen;
            }
            return outcome;
        })
    );
    return { outcomes, blocked: outcomes.some(outcome => outcome.blocks) };
}

/**
 * Mutations run in sequence by priority, each receiving the previous output.
 * Audit mode computes the mutation without applying it. A failure in active
 * mode with failOpen false halts and discards every mutation.
 */
export async function runMutators(selected: Selected[], event: string, phase: Phase, payload: unknown): Promise<MutationSummary> {
    const context = newContext();
    const ordered = applicable(selected, 'mutation', event, phase)
        .map(entry => ({ entry, priority: resolvePriority(entry, phase) }))
        .sort((a, b) => a.priority - b.priority || a.entry.interceptor.name.localeCompare(b.entry.interceptor.name));

    const outcomes: MutationOutcome[] = [];
    let current = payload;
    for (const { entry, priority } of ordered) {
        const outcome: MutationOutcome = { ...resolvePolicy(entry), priority, applied: false };
        outcomes.push(outcome);
        try {
            const request = { method: 'interceptor/invoke', params: invokeParams(entry, event, phase, current, context) };
            const result = await entry.server.request(request, MutationResultSchema);
            outcome.result = result as MutationResult;
            if (outcome.mode === 'active' && result.modified) {
                current = result.payload;
                outcome.applied = true;
            }
        } catch (error) {
            outcome.failure = error instanceof Error ? error.message : String(error);
            if (outcome.mode === 'active' && !outcome.failOpen) {
                return { outcomes, payload, failedInterceptor: entry.interceptor.name };
            }
        }
    }
    return { outcomes, payload: current };
}

/** The JSON-RPC error an invoker returns when validation blocks (SEP-2624 "Error Handling"). */
export function validationError(summary: ValidationSummary) {
    return {
        code: -32602,
        message: 'Interceptor validation failed',
        data: {
            validationErrors: summary.outcomes
                .filter(outcome => outcome.blocks)
                .flatMap(outcome =>
                    outcome.result
                        ? (outcome.result.messages ?? [])
                              .filter(message => message.severity === 'error')
                              .map(message => ({ interceptor: outcome.interceptor, ...message }))
                        : [{ interceptor: outcome.interceptor, severity: 'error' as const, message: outcome.failure ?? 'invocation failed' }]
                )
        }
    };
}

/** The JSON-RPC error an invoker returns when a mutation halts execution. */
export function mutationError(summary: MutationSummary) {
    return {
        code: -32603,
        message: 'Interceptor mutation failed',
        data: { failedInterceptor: summary.failedInterceptor, lastValidPayload: summary.payload }
    };
}
