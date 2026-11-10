// The three citation checks. Each takes a tools/call result and returns
// SEP-2624 validation messages. They are pure so the tests can call them
// without an MCP connection.
import { isIP } from 'node:net';

import { normalizeLabel, parseLinks, unlink, type ParsedLinks } from './markdown-links.ts';
import type { Citation, CitedToolResult, Severity, ValidationMessage } from './types.ts';

export interface CheckOutput {
    messages: ValidationMessage[];
    info: Record<string, unknown>;
}

interface Parsed {
    links: ParsedLinks;
    /** Entries of `citations` that are objects, with their array index. */
    citations: Array<{ index: number; citation: Citation }>;
    messages: ValidationMessage[];
}

function parse(result: CitedToolResult): Parsed {
    const text = (result.content ?? [])
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n\n');
    const parsed: Parsed = { links: parseLinks(text), citations: [], messages: [] };

    if (result.citations === undefined) return parsed;
    if (!Array.isArray(result.citations)) {
        parsed.messages.push({ path: 'citations', message: '`citations` must be an array', severity: 'error' });
        return parsed;
    }
    result.citations.forEach((entry, index) => {
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
            parsed.citations.push({ index, citation: entry as Citation });
        } else {
            parsed.messages.push({ path: `citations[${index}]`, message: 'citation must be an object', severity: 'error' });
        }
    });
    return parsed;
}

/** The destination a client would open: `citations` wins over the markdown link. */
function destination(citation: Citation, links: ParsedLinks): string | undefined {
    if (citation.url) return citation.url;
    if (citation.id) return links.definitions.get(normalizeLabel(citation.id));
    if (citation.name) return links.inline.find(link => link.text === citation.name)?.url;
    return undefined;
}

/** `c1` and `c12` share the shape `cN`. Used to spot markers that look like citation ids. */
function shape(label: string): string {
    return label.replace(/\d+/g, 'N');
}

/** Checks that markers in the text and entries in `citations` line up. */
export function checkBinding(result: CitedToolResult): CheckOutput {
    const { links, citations, messages } = parse(result);
    const ids = new Map<string, number>();
    let nameKeyed = 0;
    let blockLevel = 0;

    for (const { index, citation } of citations) {
        const path = `citations[${index}]`;
        if (!citation.id && !citation.name && !citation.url) {
            messages.push({ path, message: 'citation has none of `id`, `name`, or `url`', severity: 'error' });
            continue;
        }
        if (citation.display && !['embedded', 'external', 'auto'].includes(citation.display)) {
            messages.push({ path: `${path}.display`, message: `unknown display hint "${citation.display}"`, severity: 'warn' });
        }
        if (!citation.id) {
            if (links.inline.some(link => link.text === citation.name)) nameKeyed++;
            else blockLevel++;
            continue;
        }

        const label = normalizeLabel(citation.id);
        const first = ids.get(label);
        if (first !== undefined) {
            messages.push({ path: `${path}.id`, message: `duplicate id "${citation.id}" (also citations[${first}])`, severity: 'error' });
            continue;
        }
        ids.set(label, index);

        const definition = links.definitions.get(label);
        if (!links.markers.has(label)) {
            messages.push({
                path: `${path}.id`,
                message: `id "${citation.id}" has no [${citation.id}] marker in the content, so it reads as a block-level citation`,
                severity: 'warn'
            });
        }
        if (!citation.url && !definition) {
            messages.push({
                path,
                message: `no destination for "${citation.id}": no \`url\` and no [${citation.id}]: link definition`,
                severity: 'error'
            });
        }
        if (citation.url && definition && citation.url.split('#')[0] !== definition.split('#')[0]) {
            messages.push({
                path: `${path}.url`,
                message: `markdown definition for [${citation.id}] points to ${definition}; clients prefer the \`citations\` value`,
                severity: 'info'
            });
        }
    }

    // A marker shaped like the ids in use, with no entry in `citations`.
    const idShapes = new Set([...ids.keys()].map(shape));
    for (const marker of links.markers) {
        if (ids.has(marker) || !idShapes.has(shape(marker))) continue;
        const literal = links.definitions.has(marker) ? '' : ' and no link definition, so it renders as literal text';
        messages.push({ path: 'content', message: `marker [${marker}] has no entry in \`citations\`${literal}`, severity: 'warn' });
    }

    return { messages, info: { citations: citations.length, markerKeyed: ids.size, nameKeyed, blockLevel } };
}

export interface UrlPolicyConfig {
    /** Schemes a client may dereference. Default: https only. */
    allowedSchemes?: string[];
}

function isPrivateHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) return true;
    if (isIP(host) === 4) {
        const [a, b] = host.split('.').map(Number) as [number, number];
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    }
    if (isIP(host) === 6) {
        return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
    }
    return false;
}

/** Applies the SEP-3094 dereferencing rules to every URL a client might fetch. */
export function checkUrlPolicy(result: CitedToolResult, config: UrlPolicyConfig = {}): CheckOutput {
    const { links, citations, messages } = parse(result);
    const allowed = (config.allowedSchemes ?? ['https']).map(scheme => scheme.toLowerCase());
    let checked = 0;

    const check = (path: string, value: string | undefined) => {
        if (!value) return;
        checked++;
        let url: URL;
        try {
            url = new URL(value);
        } catch {
            messages.push({ path, message: `not an absolute URL: ${value}`, severity: 'error' });
            return;
        }
        const scheme = url.protocol.slice(0, -1);
        if (!allowed.includes(scheme)) {
            messages.push({ path, message: `scheme "${scheme}" is not in the allow-list (${allowed.join(', ')}): ${value}`, severity: 'error' });
        }
        if (isPrivateHost(url.hostname)) {
            messages.push({ path, message: `private, loopback, or link-local address: ${value}`, severity: 'error' });
        }
    };

    for (const { index, citation } of citations) {
        check(`citations[${index}].url`, destination(citation, links));
        check(`citations[${index}].thumbnailUrl`, citation.thumbnailUrl);
    }
    return { messages, info: { urlsChecked: checked } };
}

export interface QuoteCheckConfig {
    /** Severity for a quote whose source is not in the corpus. Default: info. */
    unverifiedSeverity?: Severity;
}

function normalizeQuote(text: string): string {
    return text
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/** Reads the text of a cited source by URL without its fragment, or undefined if unknown. */
export type SourceLookup = (url: string) => Promise<string | undefined>;

/** Checks that each citation's quoted `text` appears in the cited source. */
export async function checkQuotes(result: CitedToolResult, lookup: SourceLookup, config: QuoteCheckConfig = {}): Promise<CheckOutput> {
    const { links, citations, messages } = parse(result);
    const counts = { verified: 0, notFound: 0, unverified: 0 };

    for (const { index, citation } of citations) {
        if (!citation.text) continue;
        const path = `citations[${index}].text`;
        const url = destination(citation, links);
        const source = url ? await lookup(url.split('#')[0]!) : undefined;
        if (source === undefined) {
            counts.unverified++;
            messages.push({
                path,
                message: `quote not verified: ${url ? `no snapshot of ${url.split('#')[0]}` : 'citation has no destination'}`,
                severity: config.unverifiedSeverity ?? 'info'
            });
        } else if (normalizeQuote(source).includes(normalizeQuote(citation.text))) {
            counts.verified++;
        } else {
            counts.notFound++;
            messages.push({ path, message: `quoted text does not appear in ${url!.split('#')[0]}: "${citation.text}"`, severity: 'error' });
        }
    }
    return { messages, info: counts };
}

export interface Stripped {
    index: number;
    id?: string;
    name?: string;
    reasons: string[];
}

export interface StripOutput {
    result: CitedToolResult;
    stripped: Stripped[];
}

/**
 * Removes every citation that one of the checks reports at severity "error",
 * along with its marker and link definition in the text. The claim itself
 * stays, uncited. Warnings and infos do not strip.
 */
export async function stripBadCitations(result: CitedToolResult, lookup: SourceLookup, config: UrlPolicyConfig = {}): Promise<StripOutput> {
    const outputs = [checkBinding(result), checkUrlPolicy(result, config), await checkQuotes(result, lookup)];
    const errors = outputs.flatMap(output => output.messages).filter(message => message.severity === 'error');
    if (errors.length === 0) return { result, stripped: [] };

    // `citations` itself is malformed: drop the field.
    if (!Array.isArray(result.citations)) {
        const { citations: _dropped, ...rest } = result;
        return { result: rest, stripped: [{ index: -1, reasons: errors.map(error => error.message) }] };
    }

    const reasons = new Map<number, string[]>();
    for (const error of errors) {
        const index = /^citations\[(\d+)\]/.exec(error.path ?? '')?.[1];
        if (index === undefined) continue;
        reasons.set(Number(index), [...(reasons.get(Number(index)) ?? []), error.message]);
    }

    const entries = result.citations as Array<Citation | null>;
    const kept = entries.filter((_, index) => !reasons.has(index));
    const stripped = [...reasons]
        .sort(([a], [b]) => a - b)
        .map(([index, why]) => {
            const { id, name } = entries[index] ?? {};
            return { index, ...(id && { id }), ...(name && { name }), reasons: why };
        });

    // Leave a marker alone when a kept citation still uses it (a stripped duplicate id).
    const keptIds = new Set(kept.flatMap(citation => (citation?.id ? [normalizeLabel(citation.id)] : [])));
    const keptNames = new Set(kept.flatMap(citation => (citation?.name && !citation.id ? [citation.name] : [])));
    const labels = new Set(stripped.flatMap(entry => (entry.id ? [normalizeLabel(entry.id)] : [])).filter(label => !keptIds.has(label)));
    const names = new Set(stripped.flatMap(entry => (entry.name && !entry.id ? [entry.name] : [])).filter(name => !keptNames.has(name)));

    return {
        result: {
            ...result,
            content: result.content?.map(block =>
                block.type === 'text' && typeof block.text === 'string' ? { ...block, text: unlink(block.text, labels, names) } : block
            ),
            citations: kept
        },
        stripped
    };
}
