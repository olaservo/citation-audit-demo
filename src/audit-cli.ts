// Calls one tool on the portal server, audits the result, and prints an
// AuditReport as JSON. The Claude Code mod in mods/citation-audit runs this
// for each `statistics` call.
//
//   echo '{"name":"statistics","arguments":{"topic":"unemployment"}}' | tsx src/audit-cli.ts strip
import { text } from 'node:stream/consumers';

import { callAndAudit, closeHost, MODES, report, startHost, type AuditMode } from './host.ts';

const mode = (process.argv[2] ?? 'audit') as AuditMode;
if (!(mode in MODES)) {
    console.error(`unknown mode "${mode}": expected ${Object.keys(MODES).join(', ')}`);
    process.exit(2);
}

const call = JSON.parse(await text(process.stdin)) as { name: string; arguments?: Record<string, unknown> };
const host = await startHost();
try {
    const audit = await callAndAudit(host, call.name, call.arguments ?? {}, MODES[mode]);
    console.log(JSON.stringify(report(audit, mode)));
} finally {
    await closeHost(host);
}
