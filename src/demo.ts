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

function policyOf(outcome: { mode: string; modeSource: string; failOpen: boolean; failOpenSource: string }): string {
    return `mode=${outcome.mode} (${outcome.modeSource}), failOpen=${outcome.failOpen} (${outcome.failOpenSource})`;
}

function printValidation(summary: ValidationSummary): void {
    for (const outcome of summary.outcomes) {
        if (outcome.failure) {
            console.log(`  ${outcome.interceptor}  FAILED  ${policyOf(outcome)}\n      ${outcome.failure}`);
            continue;
        }
        const result = outcome.result!;
        const verdict = result.valid ? (result.severity ? `valid, ${result.severity}` : 'valid') : 'invalid';
        console.log(`  ${outcome.interceptor}  ${verdict}  ${policyOf(outcome)}  info=${JSON.stringify(result.info)}`);
        for (const message of result.messages ?? []) {
            console.log(`      ${message.severity.padEnd(5)} ${message.path ?? ''}  ${message.message}`);
        }
    }
}

function printMutation(summary: MutationSummary): void {
    for (const outcome of summary.outcomes) {
        const policy = `priority=${outcome.priority}, ${policyOf(outcome)}`;
        if (outcome.failure) {
            console.log(`  ${outcome.interceptor}  FAILED  ${policy}\n      ${outcome.failure}`);
            continue;
        }
        const result = outcome.result!;
        const verdict = !result.modified ? 'unchanged' : outcome.applied ? 'modified, applied' : 'modified, not applied (shadow)';
        console.log(`  ${outcome.interceptor}  ${verdict}  ${policy}`);
        const stripped = (result.info?.stripped ?? []) as Array<{ index: number; id?: string; name?: string; reasons: string[] }>;
        for (const entry of stripped) {
            console.log(`      strip citations[${entry.index}] ${entry.id ?? entry.name ?? ''}  ${entry.reasons.join('; ')}`);
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
    console.log(`  ${interceptor.name}  ${interceptor.type}  ${hooks}  mode=${interceptor.mode ?? 'active'}  failOpen=${interceptor.failOpen ?? false}`);
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
    console.log(`tools/call research(${topic}) returned ${(result.citations as unknown[] | undefined)?.length ?? 0} citations`);

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
    const kept = ((delivered.citations ?? []) as Citation[]).map(citation => citation.id ?? citation.name ?? '(no key)').join(', ');
    console.log(`DELIVERED with ${((delivered.citations ?? []) as unknown[]).length} citations (${kept}).`);
    if (mutation.outcomes.some(outcome => outcome.applied)) {
        console.log(delivered.content?.map(block => block.text?.trimEnd()).join('\n').replace(/^/gm, '    | '));
    }
}

await run('1. Sound citations, server defaults (audit)', 'judicial-review');
await run('2. Flawed citations, server defaults (audit): findings and the shadow mutation are logged, nothing changes', 'severance');
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
