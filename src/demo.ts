// Terminal demo. Calls the `research` tool four times and prints what the
// host's audit of each result found and delivered.
import { callAndAudit, closeHost, MODES, startHost } from './host.ts';
import type { MutationSummary, ValidationSummary } from './invoker.ts';
import { INTERCEPTORS_EXTENSION, type Citation, type CitedToolResult, type InterceptorOverrides } from './types.ts';

/** The resolved mode and failOpen, marking values set by an invoker override. */
function policyOf(outcome: { mode: string; modeSource: string; failOpen: boolean; failOpenSource: string }): string {
    const source = (value: string) => (value === 'override' ? ' (override)' : '');
    return `mode=${outcome.mode}${source(outcome.modeSource)} failOpen=${outcome.failOpen}${source(outcome.failOpenSource)}`;
}

function row(interceptor: string, verdict: string, ...rest: string[]): string {
    return `  ${interceptor.padEnd(22)}${verdict.padEnd(18)}${rest.join('  ')}`;
}

function citationsOf(result: CitedToolResult): Citation[] {
    return Array.isArray(result.citations) ? (result.citations as Citation[]) : [];
}

function printValidation(summary: ValidationSummary): void {
    for (const outcome of summary.outcomes) {
        if (outcome.failure) {
            console.log(`${row(outcome.interceptor, 'FAILED', policyOf(outcome))}\n      ${outcome.failure}`);
            continue;
        }
        const result = outcome.result!;
        const verdict = result.valid ? (result.severity ? `valid, ${result.severity}` : 'valid') : 'invalid';
        const info = Object.entries(result.info ?? {}).map(([key, value]) => `${key}=${value}`);
        console.log(row(outcome.interceptor, verdict, policyOf(outcome), info.join(' ')));
        for (const message of result.messages ?? []) {
            console.log(`      ${message.severity.padEnd(5)} ${message.path ?? ''}  ${message.message}`);
        }
    }
}

function printMutation(summary: MutationSummary): void {
    for (const outcome of summary.outcomes) {
        const policy = [policyOf(outcome), `priority=${outcome.priority}`];
        if (outcome.failure) {
            console.log(`${row(outcome.interceptor, 'FAILED', ...policy)}\n      ${outcome.failure}`);
            continue;
        }
        const result = outcome.result!;
        const verdict = !result.modified ? 'unchanged' : outcome.applied ? 'modified, applied' : 'modified, shadow';
        console.log(row(outcome.interceptor, verdict, ...policy));
        const stripped = (result.info?.stripped ?? []) as Array<{ index: number; id?: string; name?: string; reasons: string[] }>;
        for (const entry of stripped) {
            console.log(`      strip citations[${entry.index}] ${entry.id ?? entry.name ?? ''}`);
            for (const reason of entry.reasons) console.log(`          ${reason}`);
        }
    }
}

const host = await startHost();

const extension = host.interceptorServer.getServerCapabilities()?.extensions?.[INTERCEPTORS_EXTENSION];
console.log(
    `Negotiated protocol: research ${host.research.getNegotiatedProtocolVersion()}, interceptors ${host.interceptorServer.getNegotiatedProtocolVersion()}`
);
console.log(`Interceptor Server capability ${INTERCEPTORS_EXTENSION}: ${JSON.stringify(extension)}`);

console.log('interceptors/list:');
for (const interceptor of host.interceptors) {
    const hooks = interceptor.hooks.map(hook => `${hook.events.join(',')}@${hook.phase}`).join(' ');
    console.log(row(interceptor.name, interceptor.type, hooks, `mode=${interceptor.mode ?? 'active'} failOpen=${interceptor.failOpen ?? false}`));
}

async function run(title: string, topic: string, overrides: Record<string, InterceptorOverrides> = {}): Promise<void> {
    console.log(`\n=== ${title} ===`);
    const audit = await callAndAudit(host, 'research', { topic }, overrides);
    console.log(`tools/call research(${topic}) returned ${citationsOf(audit.result).length} citations`);

    console.log('validate:');
    printValidation(audit.validation);
    if (audit.mutation) {
        console.log('mutate:');
        printMutation(audit.mutation);
    }
    if (!audit.delivered) {
        console.log(`BLOCKED${audit.mutation ? '' : ' before mutation'}:`, JSON.stringify(audit.error, null, 2));
        return;
    }

    const kept = citationsOf(audit.delivered).map(citation => citation.id ?? citation.name ?? '(no key)');
    console.log(`DELIVERED with ${kept.length} citations (${kept.join(', ')}).`);
    if (audit.mutation?.outcomes.some(outcome => outcome.applied)) {
        console.log(audit.delivered.content?.map(block => block.text?.trimEnd()).join('\n').replace(/^/gm, '    | '));
    }
}

await run('1. Sound citations, server defaults (audit)', 'judicial-review');
await run('2. Flawed citations, server defaults (audit)', 'severance');
await run('3. Flawed citations, invoker promotes the stripper to active', 'severance', MODES.strip);
await run('4. Flawed citations, invoker also promotes two validators to active', 'severance', MODES.block);

await closeHost(host);
