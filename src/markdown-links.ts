// Extracts the three CommonMark link forms SEP-3094 binds citations with.
// This is a small scanner for the demo, not a CommonMark parser: it does not
// skip code spans or handle nested brackets.

export interface ParsedLinks {
    /** Link reference definitions: normalized label -> destination. */
    definitions: Map<string, string>;
    /** Labels referenced in the text as `[label]` or `[text][label]`. */
    markers: Set<string>;
    /** Inline links: `[text](destination)`. */
    inline: Array<{ text: string; url: string }>;
}

/** CommonMark label matching is case-insensitive and collapses whitespace. */
export function normalizeLabel(label: string): string {
    return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

const DEFINITION = /^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;

export function parseLinks(text: string): ParsedLinks {
    const definitions = new Map<string, string>();
    const body: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        const def = DEFINITION.exec(line);
        if (def) {
            const label = normalizeLabel(def[1]!);
            // The first definition of a label wins.
            if (!definitions.has(label)) definitions.set(label, def[2]!);
        } else {
            body.push(line);
        }
    }

    const markers = new Set<string>();
    const inline: ParsedLinks['inline'] = [];
    const bracket = /\[([^\]]+)\](?:\(([^)\s]+)[^)]*\)|\[([^\]]*)\])?/g;
    for (const match of body.join('\n').matchAll(bracket)) {
        const [, text, inlineUrl, refLabel] = match;
        if (inlineUrl !== undefined) {
            inline.push({ text: text!, url: inlineUrl.replace(/^<|>$/g, '') });
        } else {
            // `[text][label]`, or the collapsed and shortcut forms `[label][]` and `[label]`.
            markers.add(normalizeLabel(refLabel ? refLabel : text!));
        }
    }
    return { definitions, markers, inline };
}

/**
 * Removes the links bound to stripped citations: the definition and markers
 * for each label, and inline links whose text is one of `names`. Link text is
 * kept as plain text.
 */
export function unlink(text: string, labels: Set<string>, names: Set<string>): string {
    const has = (label: string) => labels.has(normalizeLabel(label));
    return text
        .split('\n')
        .filter(line => {
            const def = DEFINITION.exec(line);
            return !(def && has(def[1]!));
        })
        .join('\n')
        .replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (match, linkText: string, label: string) => (has(label || linkText) ? linkText : match))
        .replace(/ ?\[([^\]]+)\](?![[(:])/g, (match, label: string) => (has(label) ? '' : match))
        .replace(/\[([^\]]+)\]\([^)]*\)/g, (match, linkText: string) => (names.has(linkText) ? linkText : match));
}
