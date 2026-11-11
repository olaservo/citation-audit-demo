// Host for the demo. Connects to the research server and to the Interceptor
// Server, calls the `research` tool, and audits each result's citations on
// the response phase before delivering it.
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import {
    discover,
    mutationError,
    runMutators,
    runValidators,
    validationError,
    type MutationSummary,
    type Selected,
    type ValidationSummary
} from './invoker.ts';
import { CITATIONS_EXTENSION, INTERCEPTORS_EXTENSION, type Citation, type CitedToolResult, type InterceptorOverrides } from './types.ts';

async function connect(name: string, script: string, capabilities: Record<string, unknown> = {}): Promise<Client> {
    const client = new Client({ name, version: '0.1.0' }, { capabilities, versionNegotiation: { mode: 'auto' } });
    await client.connect(
        new StdioClientTransport({
            command: process.execPath,
            args: ['--import', 'tsx', fileURLToPath(new URL(script, import.meta.url))],
            stderr: 'ignore'
        })
    );
    return client;
}

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

// SEP-3094: declare that this client understands and renders citations.
const research = await connect('citation-audit-host', './research-server.ts', {
    extensions: { [CITATIONS_EXTENSION]: { render: {} } }
});
const interceptorServer = await connect('citation-audit-host', './interceptor-server.ts');

const extension = interceptorServer.getServerCapabilities()?.extensions?.[INTERCEPTORS_EXTENSION];
console.log(`Negotiated protocol: research ${research.getNegotiatedProtocolVersion()}, interceptors ${interceptorServer.getNegotiatedProtocolVersion()}`);
console.log(`Interceptor Server capability ${INTERCEPTORS_EXTENSION}: ${JSON.stringify(extension)}`);

const discovered = await discover(interceptorServer, 'tools/call');
console.log('interceptors/list:');
for (const interceptor of discovered) {
    const hooks = interceptor.hooks.map(hook => `${hook.events.join(',')}@${hook.phase}`).join(' ');
    console.log(row(interceptor.name, interceptor.type, hooks, `mode=${interceptor.mode ?? 'active'} failOpen=${interceptor.failOpen ?? false}`));
}

const CONFIG: Record<string, Record<string, unknown>> = {
    'citation-url-policy': { allowedSchemes: ['https'] },
    'citation-stripper': { allowedSchemes: ['https'] }
};

async function run(title: string, topic: string, overrides: Record<string, InterceptorOverrides> = {}): Promise<void> {
    console.log(`\n=== ${title} ===`);
    const selected: Selected[] = discovered.map(interceptor => ({
        interceptor,
        server: interceptorServer,
        overrides: overrides[interceptor.name],
        config: CONFIG[interceptor.name]
    }));

    const result = (await research.callTool({ name: 'research', arguments: { topic } })) as CitedToolResult;
    console.log(`tools/call research(${topic}) returned ${citationsOf(result).length} citations`);

    // Receiving: validate, then mutate only if validation did not block.
    console.log('validate:');
    const validation = await runValidators(selected, 'tools/call', 'response', result);
    printValidation(validation);
    if (validation.blocked) {
        console.log('BLOCKED before mutation:', JSON.stringify(validationError(validation), null, 2));
        return;
    }

    console.log('mutate:');
    const mutation = await runMutators(selected, 'tools/call', 'response', result);
    printMutation(mutation);
    if (mutation.failedInterceptor) {
        console.log('BLOCKED:', JSON.stringify(mutationError(mutation), null, 2));
        return;
    }

    const delivered = mutation.payload as CitedToolResult;
    const kept = citationsOf(delivered).map(citation => citation.id ?? citation.name ?? '(no key)');
    console.log(`DELIVERED with ${kept.length} citations (${kept.join(', ')}).`);
    if (mutation.outcomes.some(outcome => outcome.applied)) {
        console.log(delivered.content?.map(block => block.text?.trimEnd()).join('\n').replace(/^/gm, '    | '));
    }
}

await run('1. Sound citations, server defaults (audit)', 'judicial-review');
await run('2. Flawed citations, server defaults (audit)', 'severance');
await run('3. Flawed citations, invoker promotes the stripper to active', 'severance', {
    'citation-stripper': { mode: 'active', timeoutMs: 2000 }
});
await run('4. Flawed citations, invoker also promotes two validators to active', 'severance', {
    'citation-url-policy': { mode: 'active' },
    'citation-quote-check': { mode: 'active', timeoutMs: 2000 },
    'citation-stripper': { mode: 'active', timeoutMs: 2000 }
});

await research.close();
await interceptorServer.close();
