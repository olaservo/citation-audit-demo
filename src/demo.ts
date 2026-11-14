// Terminal demo. Calls the `statistics` tool and prints what the host's
// audit of each result found and delivered.
import { callAndAudit, closeHost, connect, MODES, startHost } from './host.ts';
import type { MutationSummary, ValidationSummary } from './invoker.ts';
import { CITATIONS_PATH, citationsOf, INTERCEPTORS_EXTENSION, type Citation, type CitedToolResult, type InterceptorOverrides } from './types.ts';

/** The resolved mode and failOpen, marking values set by an invoker override. */
function policyOf(outcome: { mode: string; modeSource: string; failOpen: boolean; failOpenSource: string }): string {
    const source = (value: string) => (value === 'override' ? ' (override)' : '');
    return `mode=${outcome.mode}${source(outcome.modeSource)} failOpen=${outcome.failOpen}${source(outcome.failOpenSource)}`;
}

function row(interceptor: string, verdict: string, ...rest: string[]): string {
    return `  ${interceptor.padEnd(22)}${verdict.padEnd(18)}${rest.join('  ')}`;
}

function citationList(result: CitedToolResult): Citation[] {
    const citations = citationsOf(result);
    return Array.isArray(citations) ? (citations as Citation[]) : [];
}

/** A path with the `_meta` prefix that every citation finding shares shortened. */
function short(path: string | undefined): string {
    return (path ?? '').replace(CITATIONS_PATH, 'citations');
}

function printValidation(summary: ValidationSummary): void {
    for (const outcome of summary.outcomes) {
        if (outcome.failure) {
            console.log(`${row(outcome.interceptor, 'FAILED', policyOf(outcome))}\n      ${outcome.failure}`);
            continue;
        }
        const result = outcome.result!;
        const verdict = result.valid ? (result.severity ? `valid, ${result.severity}` : 'valid') : 'invalid';
        // Counts only. Per-citation detail is in the messages below.
        const info = Object.entries(result.info ?? {})
            .filter(([, value]) => typeof value !== 'object')
            .map(([key, value]) => `${key}=${value}`);
        console.log(row(outcome.interceptor, verdict, policyOf(outcome), info.join(' ')));
        for (const message of result.messages ?? []) {
            console.log(`      ${message.severity.padEnd(5)} ${short(message.path)}  ${message.message}`);
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
    `Negotiated protocol: portal ${host.portal.getNegotiatedProtocolVersion()}, interceptors ${host.interceptorServer.getNegotiatedProtocolVersion()}`
);
console.log(`Interceptor Server capability ${INTERCEPTORS_EXTENSION}: ${JSON.stringify(extension)}`);

console.log('interceptors/list:');
for (const interceptor of host.interceptors) {
    const hooks = interceptor.hooks.map(hook => `${hook.events.join(',')}@${hook.phase}`).join(' ');
    console.log(row(interceptor.name, interceptor.type, hooks, `mode=${interceptor.mode ?? 'active'} failOpen=${interceptor.failOpen ?? false}`));
}

async function run(title: string, topic: string, overrides: Record<string, InterceptorOverrides> = {}): Promise<void> {
    console.log(`\n=== ${title} ===`);
    const audit = await callAndAudit(host, 'statistics', { topic }, overrides);
    const sent = citationsOf(audit.result) === undefined ? 'no citations' : `${citationList(audit.result).length} citations`;
    console.log(`tools/call statistics(${topic}) returned ${sent} in ${CITATIONS_PATH}`);

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

    // Names are quoted because they contain commas.
    const kept = citationList(audit.delivered).map(citation => citation.id ?? (citation.name ? `"${citation.name}"` : '(no key)'));
    console.log(`DELIVERED with ${kept.length} citations${kept.length > 0 ? ` (${kept.join(', ')})` : ''}.`);
    if (audit.mutation?.outcomes.some(outcome => outcome.applied)) {
        console.log(audit.delivered.content?.map(block => block.text?.trimEnd()).join('\n').replace(/^/gm, '    | '));
    }
}

await run('1. Sound citations, server defaults (audit)', 'population');
await run('2. Flawed citations, server defaults (audit)', 'unemployment');
await run('3. Flawed citations, invoker promotes the filter to active', 'unemployment', MODES.strip);
await run('4. Flawed citations, invoker also promotes three validators to active', 'unemployment', MODES.block);
await run('5. An answer with no citations, server defaults (audit)', 'inflation');

console.log('\n=== 6. A client that does not declare citations ===');
for (const [policy, env] of [
    ['SEP-3094 default', undefined],
    ['PORTAL_REQUIRE_RENDER=1', { PORTAL_REQUIRE_RENDER: '1' }]
] as const) {
    const plain = await connect('./portal-server.ts', {}, env);
    const result = (await plain.callTool({ name: 'statistics', arguments: { topic: 'population' } })) as CitedToolResult & { isError?: boolean };
    const outcome = result.isError ? 'a tool error' : `the text and ${citationsOf(result) === undefined ? 'no citations in `_meta`' : `${citationList(result).length} citations`}`;
    console.log(`${policy}: tools/call statistics(population) returned ${outcome}`);
    if (result.isError) console.log(result.content?.map(block => block.text).join('\n').replace(/^/gm, '    | '));
    await plain.close();
}

console.log('\n=== 7. The same client through a gateway that is the invoker ===');
for (const mode of ['strip', 'block']) {
    const viaGateway = await connect('./gateway.ts', {}, { GATEWAY_MODE: mode });
    try {
        const result = (await viaGateway.callTool({ name: 'statistics', arguments: { topic: 'unemployment' } })) as CitedToolResult;
        console.log(`GATEWAY_MODE=${mode}: delivered, ${citationsOf(result) === undefined ? 'no citations in `_meta`' : `${citationList(result).length} citations`}`);
        console.log(result.content?.map(block => block.text?.trimEnd()).join('\n').replace(/^/gm, '    | '));
    } catch (error) {
        const { code, message } = error as { code?: number; message: string };
        console.log(`GATEWAY_MODE=${mode}: error ${code} ${message}`);
    }
    await viaGateway.close();
}

await closeHost(host);
