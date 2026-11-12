// The four citation checks and the filter. Each check takes a tools/call
// result and returns SEP-2624 validation messages. They are pure so the tests
// can call them without an MCP connection.
import { isIP } from 'node:net';

import { normalizeLabel, parseLinks, unlink, type ParsedLinks } from './markdown-links.ts';
import { CITATIONS_PATH, citationsOf, withCitations, type Citation, type CitedToolResult, type Severity, type ValidationMessage } from './types.ts';

export interface CheckOutput {
    messages: ValidationMessage[];
    info: Record<string, unknown>;
}

interface Parsed {
    links: ParsedLinks;
    /** Citations that are objects, with their array index. */
    citations: Array<{ index: number; citation: Citation }>;
    /** Shape errors. Only the binding check reports them. */
    messages: ValidationMessage[];
}

const STRING_FIELDS = ['id', 'name', 'url', 'text', 'description', 'thumbnailUrl', 'datePublished', 'display', 'license'] as const;

function parse(result: CitedToolResult): Parsed {
    const text = (Array.isArray(result.content) ? result.content : [])
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n\n');
    const parsed: Parsed = { links: parseLinks(text), citations: [], messages: [] };

    const raw = citationsOf(result);
    if (raw === undefined) return parsed;
    if (!Array.isArray(raw)) {
        parsed.messages.push({ path: CITATIONS_PATH, message: 'citations must be an array', severity: 'error' });
        return parsed;
    }
    raw.forEach((entry, index) => {
        const path = `${CITATIONS_PATH}[${index}]`;
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            parsed.messages.push({ path, message: 'citation must be an object', severity: 'error' });
            return;
        }
        const wrong = STRING_FIELDS.filter(field => field in entry && typeof (entry as Record<string, unknown>)[field] !== 'string');
        if (wrong.length > 0) {
            parsed.messages.push({ path, message: `${wrong.map(field => `\`${field}\``).join(', ')} must be a string`, severity: 'error' });
            return;
        }
        parsed.citations.push({ index, citation: entry as Citation });
    });
    return parsed;
}

/** The string `id` and `name` of an entry that may be malformed. */
function keysOf(entry: unknown): { id?: string; name?: string } {
    const { id, name } = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    return { ...(typeof id === 'string' && id && { id }), ...(typeof name === 'string' && name && { name }) };
}

/** The index of the citation a validation message's `path` points into, if any. */
export function citationIndex(path: string | undefined): number | undefined {
    if (!path?.startsWith(`${CITATIONS_PATH}[`)) return undefined;
    const index = /^\[(\d+)\]/.exec(path.slice(CITATIONS_PATH.length))?.[1];
    return index === undefined ? undefined : Number(index);
}

/** The destination of the markdown link a citation is bound to, if any. */
function markdownDestination(citation: Citation, links: ParsedLinks): string | undefined {
    if (citation.id) return links.definitions.get(normalizeLabel(citation.id));
    if (citation.name) return links.inline.find(link => link.text === citation.name)?.url;
    return undefined;
}

function withoutFragment(url: string): string {
    return url.split('#')[0]!;
}

/** The labels and names that bind these citations to links in the text. */
function boundKeys(citations: ReadonlyArray<Citation | null>): { labels: Set<string>; names: Set<string> } {
    const labels = new Set<string>();
    const names = new Set<string>();
    for (const citation of citations) {
        if (citation?.id) labels.add(normalizeLabel(citation.id));
        else if (citation?.name) names.add(citation.name);
    }
    return { labels, names };
}

/** The destination a client would open: the citation's `url` wins over the markdown link. */
function destination(citation: Citation, links: ParsedLinks): string | undefined {
    return citation.url || markdownDestination(citation, links);
}

/** The name of a schema.org Person or Organization, given as a string, an object, or a list. */
function partyName(party: unknown): string | undefined {
    if (typeof party === 'string') return party.trim() || undefined;
    if (Array.isArray(party)) return party.map(partyName).find(Boolean);
    if (party && typeof party === 'object') return partyName((party as { name?: unknown }).name);
    return undefined;
}

export interface CitationInfo {
    index: number;
    /** The citation's `id`, else its `name`, else its index. */
    key: string;
    name?: string;
    url?: string;
    /** Whether the citation quotes its source in `text`. */
    quotes: boolean;
    license?: string;
    /** The name of the `publisher`, else of the `author`. */
    credit?: string;
}

/** One entry per citation, with the destination a client would open. */
export function listCitations(result: CitedToolResult): CitationInfo[] {
    const { links, citations } = parse(result);
    const raw = citationsOf(result);
    if (!Array.isArray(raw)) return [];
    const parsed = new Map(citations.map(({ index, citation }) => [index, citation]));
    return raw.map((entry, index) => {
        const citation = parsed.get(index);
        if (!citation) {
            const { id, name } = keysOf(entry);
            return { index, key: id ?? name ?? `#${index}`, ...(name && { name }), quotes: false };
        }
        const url = destination(citation, links);
        const credit = partyName(citation.publisher) ?? partyName(citation.author);
        return {
            index,
            key: citation.id ?? citation.name ?? `#${index}`,
            ...(citation.name && { name: citation.name }),
            ...(url && { url }),
            quotes: Boolean(citation.text),
            ...(citation.license && { license: citation.license }),
            ...(credit && { credit })
        };
    });
}

/** `c1` and `c12` share the shape `cN`. Used to spot markers that look like citation ids. */
function shape(label: string): string {
    return label.replace(/\d+/g, 'N');
}

export interface BindingConfig {
    /** Severity for a result with no citations at all. Default: not reported. */
    uncitedSeverity?: Severity;
}

/** Checks that markers in the text and the citations in `_meta` line up. */
export function checkBinding(result: CitedToolResult, config: BindingConfig = {}): CheckOutput {
    const { links, citations, messages } = parse(result);
    const raw = citationsOf(result);
    if (config.uncitedSeverity && (raw === undefined || (Array.isArray(raw) && raw.length === 0))) {
        messages.push({ path: CITATIONS_PATH, message: 'result carries no citations, so its claims cannot be traced to a source', severity: config.uncitedSeverity });
    }
    const ids = new Map<string, number>();
    let markerKeyed = 0;
    let nameKeyed = 0;
    let blockLevel = 0;

    for (const { index, citation } of citations) {
        const path = `${CITATIONS_PATH}[${index}]`;
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
            // SEP-3094 has no uniqueness rule for `id`, so this does not strip.
            messages.push({ path: `${path}.id`, message: `duplicate id "${citation.id}" (also ${CITATIONS_PATH}[${first}])`, severity: 'warn' });
            continue;
        }
        ids.set(label, index);

        const definition = links.definitions.get(label);
        if (links.markers.has(label)) {
            markerKeyed++;
        } else {
            blockLevel++;
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
                severity: 'warn'
            });
        }
        if (citation.url && definition && withoutFragment(citation.url) !== withoutFragment(definition)) {
            messages.push({
                path: `${path}.url`,
                message: `markdown definition for [${citation.id}] points to ${definition}; clients prefer the citation's \`url\``,
                severity: 'info'
            });
        }
    }

    // A marker shaped like the ids in use, with no citation.
    const idShapes = new Set([...ids.keys()].map(shape));
    for (const marker of links.markers) {
        if (ids.has(marker) || !idShapes.has(shape(marker))) continue;
        const literal = links.definitions.has(marker) ? '' : ' and no link definition, so it renders as literal text';
        messages.push({ path: 'content', message: `marker [${marker}] has no citation${literal}`, severity: 'warn' });
    }

    return { messages, info: { citations: citations.length, markerKeyed, nameKeyed, blockLevel } };
}

export interface UrlPolicyConfig {
    /** Schemes a client may dereference. Default: https only. */
    allowedSchemes?: string[];
}

function isPrivateHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) return true;
    // IPv6 forms that embed an IPv4 address: mapped, compatible, and NAT64.
    // The URL parser writes ::ffff:127.0.0.1 as ::ffff:7f00:1.
    const embedded = /^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (embedded) {
        const [high, low] = [parseInt(embedded[1]!, 16), parseInt(embedded[2]!, 16)];
        return isPrivateHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    if (isIP(host) === 4) {
        const [a, b] = host.split('.').map(Number) as [number, number];
        return (
            a === 0 ||
            a === 10 ||
            a === 127 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168)
        );
    }
    if (isIP(host) === 6) {
        // Loopback, unspecified, unique local, link-local, and site-local.
        return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89a-f]/.test(host);
    }
    return false;
}

/**
 * A deployment policy based on the SEP-3094 dereferencing rules, applied to
 * every URL a reader could follow. The SEP restricts only automatic fetching
 * and allows MCP-resolved schemes. This check reports any scheme outside the
 * allow-list.
 */
export function checkUrlPolicy(result: CitedToolResult, config: UrlPolicyConfig = {}): CheckOutput {
    const { links, citations } = parse(result);
    const messages: ValidationMessage[] = [];
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
        // A client that ignores the citations still follows the markdown link.
        // Its findings go on the citation, which has no field holding the URL.
        const linked = markdownDestination(citation, links);
        check(`${CITATIONS_PATH}[${index}].url`, citation.url);
        if (linked !== citation.url) check(`${CITATIONS_PATH}[${index}]`, linked);
        check(`${CITATIONS_PATH}[${index}].thumbnailUrl`, citation.thumbnailUrl);
    }

    // Links in the text that no citation is bound to.
    const { labels, names } = boundKeys(citations.map(({ citation }) => citation));
    for (const [label, url] of links.definitions) if (!labels.has(label)) check('content', url);
    for (const link of links.inline) if (!names.has(link.text)) check('content', link.url);

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

export type QuoteOutcome = 'verified' | 'not found' | 'unverified';

/** Reads the text of a cited source by URL without its fragment, or undefined if unknown. */
export type SourceLookup = (url: string) => Promise<string | undefined>;

/** Checks that each citation's quoted `text` appears in the cited source. */
export async function checkQuotes(result: CitedToolResult, lookup: SourceLookup, config: QuoteCheckConfig = {}): Promise<CheckOutput> {
    const { links, citations } = parse(result);
    const messages: ValidationMessage[] = [];
    const counts = { verified: 0, notFound: 0, unverified: 0 };
    /** What the check found for each quoting citation, by index. */
    const quotes: Record<number, QuoteOutcome> = {};

    for (const { index, citation } of citations) {
        if (!citation.text) continue;
        const path = `${CITATIONS_PATH}[${index}].text`;
        const url = destination(citation, links);
        const source = url ? await lookup(withoutFragment(url)) : undefined;
        if (source === undefined) {
            counts.unverified++;
            quotes[index] = 'unverified';
            messages.push({
                path,
                message: `quote not verified: ${url ? `no snapshot of ${withoutFragment(url)}` : 'citation has no destination'}`,
                severity: config.unverifiedSeverity ?? 'info'
            });
        } else if (normalizeQuote(source).includes(normalizeQuote(citation.text))) {
            counts.verified++;
            quotes[index] = 'verified';
        } else {
            counts.notFound++;
            quotes[index] = 'not found';
            messages.push({ path, message: `quoted text does not appear in ${withoutFragment(url!)}: "${citation.text}"`, severity: 'error' });
        }
    }
    return { messages, info: { ...counts, quotes } };
}

export interface LicenseConfig {
    /** Severity for a citation with no `license`. Default: error. */
    missingSeverity?: Severity;
}

// Creative Commons and Open Data Commons licenses whose terms require credit.
const REQUIRES_ATTRIBUTION = /creativecommons\.org\/licenses\/by|opendatacommons\.org\/licenses\/(by|odbl)|\bCC[ -]BY\b|\bODbL\b|\bODC-BY\b/i;

/**
 * Checks that each citation says under what terms its source may be reused,
 * and names someone to credit when those terms require attribution.
 */
export function checkLicense(result: CitedToolResult, config: LicenseConfig = {}): CheckOutput {
    const { citations } = parse(result);
    const messages: ValidationMessage[] = [];
    const counts = { licensed: 0, unlicensed: 0, uncredited: 0 };

    for (const { index, citation } of citations) {
        // The binding check reports an entry with nothing to identify it.
        if (!citation.id && !citation.name && !citation.url) continue;
        const path = `${CITATIONS_PATH}[${index}]`;
        if (!citation.license) {
            counts.unlicensed++;
            messages.push({
                path: `${path}.license`,
                message: 'citation has no `license`, so the terms of reuse are unknown',
                severity: config.missingSeverity ?? 'error'
            });
        } else if (REQUIRES_ATTRIBUTION.test(citation.license) && !partyName(citation.publisher) && !partyName(citation.author)) {
            counts.uncredited++;
            messages.push({
                path: `${path}.license`,
                message: `license requires attribution and the citation names no \`publisher\` or \`author\`: ${citation.license}`,
                severity: 'error'
            });
        } else {
            counts.licensed++;
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
 * Removes every citation that the binding, URL policy, or quote check reports
 * at severity "error", along with its marker and link definition in the text.
 * The claim itself stays, uncited. Warnings and infos do not strip. A license
 * error does not strip either: removing the citation removes the credit.
 */
export async function stripBadCitations(result: CitedToolResult, lookup: SourceLookup, config: UrlPolicyConfig = {}): Promise<StripOutput> {
    const outputs = [checkBinding(result), checkUrlPolicy(result, config), await checkQuotes(result, lookup)];
    const errors = outputs.flatMap(output => output.messages).filter(message => message.severity === 'error');
    const raw = citationsOf(result);
    if (errors.length === 0 || raw === undefined) return { result, stripped: [] };

    // The value itself is malformed: drop the key.
    if (!Array.isArray(raw)) {
        return { result: withCitations(result), stripped: [{ index: -1, reasons: errors.map(error => error.message) }] };
    }

    const reasons = new Map<number, string[]>();
    for (const error of errors) {
        const index = citationIndex(error.path);
        if (index === undefined) continue;
        reasons.set(index, [...(reasons.get(index) ?? []), error.message]);
    }
    // Errors about links in the text that no citation is bound to strip nothing.
    if (reasons.size === 0) return { result, stripped: [] };

    const entries = raw as Array<Citation | null>;
    const kept = entries.filter((_, index) => !reasons.has(index));
    const stripped = [...reasons]
        .sort(([a], [b]) => a - b)
        .map(([index, why]) => ({ index, ...keysOf(entries[index]), reasons: why }));

    // Leave a marker alone when a kept citation still uses it (a stripped duplicate id).
    const keptKeys = boundKeys(kept);
    const strippedKeys = boundKeys(stripped);
    const labels = new Set([...strippedKeys.labels].filter(label => !keptKeys.labels.has(label)));
    const names = new Set([...strippedKeys.names].filter(name => !keptKeys.names.has(name)));

    return {
        result: withCitations(
            {
                ...result,
                content: result.content?.map(block =>
                    block.type === 'text' && typeof block.text === 'string' ? { ...block, text: unlink(block.text, labels, names) } : block
                )
            },
            kept
        ),
        stripped
    };
}
