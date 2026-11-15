// Runs the probe server under Claude Code and prints which parts of a tool
// result reach the model, a mod, and the session record.
//
//   npm run probe
//
// It starts `claude -p` twice, without and then with the mod in probe/mod, so
// the mod cannot change what the first run shows. Each run makes two tool
// calls on your account.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

const OUT = 'probe/out';
const TOOLS = ['plain', 'structured'];
const PARTS = [
    ['`content` text', 'MARK_CONTENT_TEXT'],
    ["A content block's own `_meta`", 'MARK_BLOCK_META'],
    ['Result `_meta`', 'MARK_RESULT_META'],
    ['Top-level `citations`', 'MARK_TOP_LEVEL'],
    ['`structuredContent`', 'MARK_STRUCTURED']
] as const;
const PROMPT = 'Call the tool mcp__probe__plain once, then the tool mcp__probe__structured once. Then reply "done".';

interface Seen {
    /** The `tool_result` block sent to the model. */
    model: string;
    /** `tool_use_result`, which the session keeps. */
    record: string;
}

interface StreamEvent {
    type: string;
    subtype?: string;
    claude_code_version?: string;
    message?: { content?: Array<{ type: string; id?: string; name?: string; tool_use_id?: string; content?: unknown }> };
    tool_use_result?: unknown;
}

/** Runs one headless session and returns what it did with each probe call. */
function run(withMod: boolean): { version: string; seen: Record<string, Seen> } {
    const args = [
        '-p',
        ...['--model', 'sonnet'],
        ...['--mcp-config', 'probe/probe.mcp.json', '--strict-mcp-config'],
        ...['--allowedTools', ...TOOLS.map(tool => `mcp__probe__${tool}`)],
        ...['--output-format', 'stream-json', '--verbose'],
        ...(withMod ? ['--plugin-dir', 'probe/mod'] : [])
    ];
    const ran = spawnSync('claude', args, { input: PROMPT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (ran.error || ran.status !== 0) throw new Error(`claude -p failed: ${ran.error?.message ?? ran.stderr}`);

    let version = 'unknown';
    const names = new Map<string, string>();
    const seen: Record<string, Seen> = {};
    for (const line of ran.stdout.split('\n').filter(Boolean)) {
        const event = JSON.parse(line) as StreamEvent;
        if (event.type === 'system' && event.subtype === 'init') version = event.claude_code_version ?? version;
        for (const block of event.message?.content ?? []) {
            if (block.type === 'tool_use') names.set(block.id!, block.name!.replace('mcp__probe__', ''));
            if (block.type === 'tool_result') {
                seen[names.get(block.tool_use_id!) ?? ''] = { model: JSON.stringify(block.content), record: JSON.stringify(event.tool_use_result ?? null) };
            }
        }
    }
    return { version, seen };
}

const yesNo = (text: string | undefined, marker: string) => (text === undefined ? 'not run' : text.includes(marker) ? 'yes' : 'no');

rmSync(OUT, { recursive: true, force: true });
const bare = run(false);
run(true);

console.log(`Claude Code ${bare.version}`);
for (const tool of TOOLS) {
    const mod = JSON.parse(readFileSync(`${OUT}/mod-${tool}.json`, 'utf8')) as { hookResult: unknown; mcpCall: unknown };
    const hook = JSON.stringify(mod.hookResult);
    const direct = JSON.stringify(mod.mcpCall);
    console.log(`\nThe \`${tool}\` tool\n`);
    console.log('| Part of the result | Model | Mod | Session record |\n| --- | --- | --- | --- |');
    for (const [part, marker] of PARTS) {
        if (marker === 'MARK_STRUCTURED' && tool !== 'structured') continue;
        const inHook = yesNo(hook, marker);
        const inDirect = yesNo(direct, marker);
        const modCell = inHook === inDirect ? inHook : `hook ${inHook}, \`$.mcp.call\` ${inDirect}`;
        console.log(`| ${part} | ${yesNo(bare.seen[tool]?.model, marker)} | ${modCell} | ${yesNo(bare.seen[tool]?.record, marker)} |`);
    }
}
