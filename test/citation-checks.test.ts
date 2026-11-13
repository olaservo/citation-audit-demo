import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkBinding, checkLicense, checkQuotes, checkUrlPolicy, listCitations, stripBadCitations } from '../src/citation-checks.ts';
import { report } from '../src/host.ts';
import { messagesOf } from '../src/invoker.ts';
import { parseLinks, unlink } from '../src/markdown-links.ts';
import { CITATIONS_META_KEY, CITATIONS_PATH, citationsOf } from '../src/types.ts';

const URL_A = 'https://example.com/a';
const text = (value: string) => [{ type: 'text', text: value }];
/** A result's `_meta` holding these citations. */
const meta = <T>(citations: T) => ({ [CITATIONS_META_KEY]: citations });
/** The path of a citation, or of a field in it. */
const at = (index: number, field = '') => `${CITATIONS_PATH}[${index}]${field}`;
const severities = (messages: Array<{ severity: string }>) => messages.map(message => message.severity);

test('parseLinks finds definitions, markers, and inline links', () => {
    const links = parseLinks(`Claim [c1]. Also [the case][C2] and [inline](${URL_A}).\n\n[c1]: ${URL_A} "Title"\n[c2]: <${URL_A}>`);
    assert.deepEqual([...links.definitions], [['c1', URL_A], ['c2', URL_A]]);
    assert.deepEqual([...links.markers], ['c1', 'c2']);
    assert.deepEqual(links.inline, [{ text: 'inline', url: URL_A }]);
});

test('binding accepts the three minimalist forms from SEP-3094', () => {
    const result = {
        content: text(`One [c1]. Two [title][c2]. Three [Named](${URL_A}).\n\n[c1]: ${URL_A}\n[c2]: ${URL_A}`),
        _meta: meta([{ id: 'c1' }, { id: 'c2' }, { name: 'Named' }])
    };
    const { messages, info } = checkBinding(result);
    assert.deepEqual(messages, []);
    assert.deepEqual(info, { citations: 3, markerKeyed: 2, nameKeyed: 1, blockLevel: 0, pointerKeyed: 0 });
});

test('binding treats an unmatched name as a block-level citation', () => {
    const { messages, info } = checkBinding({ content: text('No markers.'), _meta: meta([{ name: 'Whole answer', url: URL_A }]) });
    assert.deepEqual(messages, []);
    assert.equal(info.blockLevel, 1);
});

test('binding reports empty, duplicate, unbound, and dangling entries, and only an empty entry is an error', () => {
    const { messages } = checkBinding({
        content: text(`One [c1]. Two [c2]. Three [c3].\n\n[c1]: ${URL_A}`),
        _meta: meta([{ id: 'c1' }, { id: 'c1' }, { id: 'c2' }, { id: 'c9', url: URL_A }, { description: 'nothing else' }])
    });
    assert.deepEqual(
        messages.map(message => [message.path, message.severity]),
        [
            [at(1, '.id'), 'warn'], // duplicate
            [at(2), 'warn'], // c2 has no destination
            [at(3, '.id'), 'warn'], // c9 has no marker
            [at(4), 'error'], // none of id, name, url
            ['content', 'warn'] // [c3] has no citation
        ]
    );
});

test('binding counts an id with no marker as block-level', () => {
    const { info } = checkBinding({ content: text(`One [c1].\n\n[c1]: ${URL_A}`), _meta: meta([{ id: 'c1' }, { id: 'c2', url: URL_A }]) });
    assert.deepEqual(info, { citations: 2, markerKeyed: 1, nameKeyed: 0, blockLevel: 1, pointerKeyed: 0 });
});

test('only the binding check rejects a non-array citations value and a field of the wrong type', async () => {
    assert.deepEqual(severities(checkBinding({ content: text('x'), _meta: meta({ id: 'c1' }) }).messages), ['error']);
    const result = { content: text('x'), _meta: meta([{ id: 5, name: 'Five' }]) };
    assert.deepEqual(checkBinding(result).messages, [{ path: at(0), message: '`id` must be a string', severity: 'error' }]);
    const others = [checkUrlPolicy(result), await checkQuotes(result, async () => undefined), checkLicense(result)];
    assert.deepEqual(others.flatMap(output => output.messages), []);
    assert.deepEqual((await stripBadCitations(result, async () => undefined)).stripped, [{ index: 0, name: 'Five', reasons: ['`id` must be a string'] }]);
});

test('url policy allows https and rejects other schemes and private hosts', () => {
    const urls = [
        'https://example.com/ok',
        'http://example.com/plain',
        'file:///etc/passwd',
        'https://localhost/x',
        'https://10.0.0.8/x',
        'https://[::1]/x',
        'https://169.254.169.254/latest',
        'https://localhost./x',
        'https://[::ffff:127.0.0.1]/x',
        'https://[::127.0.0.1]/x',
        'https://[64:ff9b::7f00:1]/x',
        'https://[fec0::1]/x',
        'https://100.64.0.1/x',
        'not a url'
    ];
    const { messages } = checkUrlPolicy({ _meta: meta(urls.map(url => ({ url }))) });
    assert.deepEqual(
        messages.map(message => message.path),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(index => at(index, '.url'))
    );
});

test('url policy checks the markdown destination of a minimalist citation and honours allowedSchemes', () => {
    const result = { content: text('Claim [c1].\n\n[c1]: http://example.com/a'), _meta: meta([{ id: 'c1' }]) };
    assert.equal(checkUrlPolicy(result).messages.length, 1);
    assert.equal(checkUrlPolicy(result, { allowedSchemes: ['https', 'http'] }).messages.length, 0);
});

test('url policy checks the markdown link beside a citation url, and links no citation is bound to', () => {
    const result = {
        content: text(`One [c1]. See [here](http://localhost/x).\n\n[c1]: http://169.254.169.254/x\n[other]: file:///etc/passwd`),
        _meta: meta([{ id: 'c1', url: URL_A }])
    };
    assert.deepEqual(
        checkUrlPolicy(result).messages.map(message => message.path),
        [at(0), at(0), 'content', 'content', 'content']
    );
});

test('quote check verifies, rejects, and reports unverifiable quotes', async () => {
    const lookup = async (url: string) => (url === URL_A ? 'The  quick brown fox\njumps over the lazy dog.' : undefined);
    const result = {
        content: text(`One [c1].\n\n[c1]: ${URL_A}#section`),
        _meta: meta([
            { id: 'c1', text: 'quick brown fox jumps' },
            { name: 'B', url: `${URL_A}#:~:text=x`, text: 'The fox was slow.' },
            { name: 'C', url: 'https://example.com/unknown', text: 'anything' }
        ])
    };
    const { messages, info } = await checkQuotes(result, lookup);
    assert.deepEqual(info, { verified: 1, notFound: 1, unverified: 1, quotes: { 0: 'verified', 1: 'not found', 2: 'unverified' } });
    assert.deepEqual(
        messages.map(message => [message.path, message.severity]),
        [
            [at(1, '.text'), 'error'],
            [at(2, '.text'), 'info']
        ]
    );
    const strict = await checkQuotes(result, lookup, { unverifiedSeverity: 'warn' });
    assert.equal(strict.messages[1]!.severity, 'warn');
});

test('report labels an unverifiable quote unverified at any severity', async () => {
    const lookup = async () => undefined;
    const result = { content: text('One.'), _meta: meta([{ name: 'A', url: URL_A, text: 'quoted' }]) };
    const check = await checkQuotes(result, lookup, { unverifiedSeverity: 'error' });
    const outcome = {
        interceptor: 'citation-quote-check',
        mode: 'audit' as const,
        modeSource: 'default' as const,
        failOpen: true,
        failOpenSource: 'default' as const,
        blocks: false,
        result: { interceptor: 'citation-quote-check', type: 'validation' as const, phase: 'response' as const, valid: false, ...check }
    };
    const audit = { result, validation: { outcomes: [outcome], blocked: false }, delivered: result };
    const [row] = report(audit, 'audit').citations;
    assert.equal(row!.status, 'flagged');
    assert.equal(row!.quote, 'unverified');
});

test('report labels a quote unverified when the quote check failed', () => {
    const result = { content: text('One.'), _meta: meta([{ name: 'A', url: URL_A, text: 'quoted' }, { name: 'B', url: URL_A }]) };
    const outcome = {
        interceptor: 'citation-quote-check',
        mode: 'audit' as const,
        modeSource: 'default' as const,
        failOpen: true,
        failOpenSource: 'default' as const,
        blocks: false,
        failure: 'crashed'
    };
    const audit = { result, validation: { outcomes: [outcome], blocked: false }, delivered: result };
    const rows = report(audit, 'audit').citations;
    assert.deepEqual(rows.map(row => [row.status, row.quote]), [['passed', 'unverified'], ['passed', undefined]]);
});

test('report lists a malformed citation the filter stripped', async () => {
    const result = { content: text('One.'), _meta: meta([{ id: 5, name: 'Five' }, null]) };
    const binding = checkBinding(result);
    const { result: clean, stripped } = await stripBadCitations(result, async () => undefined);
    const outcome = (interceptor: string) => ({
        interceptor,
        mode: 'active' as const,
        modeSource: 'override' as const,
        failOpen: false,
        failOpenSource: 'default' as const
    });
    const audit = {
        result,
        validation: {
            outcomes: [{ ...outcome('citation-binding'), blocks: false, result: { interceptor: 'citation-binding', type: 'validation' as const, phase: 'response' as const, valid: false, ...binding } }],
            blocked: false
        },
        mutation: {
            outcomes: [{ ...outcome('citation-filter'), priority: -10000, applied: true, result: { interceptor: 'citation-filter', type: 'mutation' as const, phase: 'response' as const, modified: true, payload: clean, info: { stripped } } }],
            payload: clean
        },
        delivered: clean
    };
    assert.deepEqual(
        report(audit, 'strip').citations.map(row => [row.key, row.status]),
        [
            ['Five', 'stripped'],
            ['#1', 'stripped']
        ]
    );
});

test('binding check reports a result with no citations when configured to', () => {
    for (const result of [{ content: text('A figure.') }, { content: text('A figure.'), _meta: meta([]) }]) {
        assert.deepEqual(checkBinding(result).messages, []);
        assert.deepEqual(
            checkBinding(result, { uncitedSeverity: 'warn' }).messages.map(message => [message.path, message.severity]),
            [[CITATIONS_PATH, 'warn']]
        );
    }
    assert.deepEqual(checkBinding({ content: text('x'), _meta: meta([{ name: 'A', url: URL_A }]) }, { uncitedSeverity: 'warn' }).messages, []);
});

test('license check wants a license, and someone to credit when the license requires it', () => {
    const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';
    const result = {
        content: text('No markers.'),
        _meta: meta([
            { name: 'A', license: CC_BY, publisher: { type: 'Organization', name: 'Office' } },
            { name: 'B', license: 'ODbL-1.0', author: [{ name: 'Someone' }] },
            { name: 'C', license: 'https://creativecommons.org/publicdomain/zero/1.0/' },
            { name: 'D', license: CC_BY, publisher: { name: ' ' } },
            { name: 'E' },
            { description: 'left to the binding check' }
        ])
    };
    const { messages, info } = checkLicense(result);
    assert.deepEqual(info, { licensed: 3, unlicensed: 1, uncredited: 1 });
    assert.deepEqual(
        messages.map(message => [message.path, message.severity]),
        [
            [at(3, '.license'), 'error'],
            [at(4, '.license'), 'error']
        ]
    );
    assert.equal(checkLicense(result, { missingSeverity: 'warn' }).messages[1]!.severity, 'warn');
    assert.deepEqual(
        listCitations(result).map(citation => citation.credit),
        ['Office', 'Someone', undefined, undefined, undefined, undefined]
    );
});

test('filter leaves a citation whose only error is its license', async () => {
    const result = { content: text(`One [c1].\n\n[c1]: ${URL_A}`), _meta: meta([{ id: 'c1' }]) };
    assert.equal(checkLicense(result).messages[0]!.severity, 'error');
    assert.deepEqual((await stripBadCitations(result, async () => undefined)).stripped, []);
});

test('unlink removes definitions and markers and keeps link text', () => {
    const before = `One [c1]. Two [the case][c2]. Three [Named](${URL_A}). Four [c3].\n\n[c1]: ${URL_A}\n[c2]: ${URL_A}\n[c3]: ${URL_A}`;
    const after = unlink(before, new Set(['c1', 'c2']), new Set(['Named']));
    assert.equal(after, `One. Two the case. Three Named. Four [c3].\n\n[c3]: ${URL_A}`);
});

test('filter removes citations with errors and leaves a result that passes every check', async () => {
    const lookup = async (url: string) => (url === URL_A ? 'The quick brown fox.' : undefined);
    const result = {
        content: text(`Good [c1]. Fabricated [c2]. Unsafe [c3]. Unbound.\n\n[c1]: ${URL_A}\n[c2]: ${URL_A}\n[c3]: https://localhost/x`),
        _meta: meta([
            { id: 'c1', text: 'quick brown fox' },
            { id: 'c2', text: 'The fox was slow.' },
            { id: 'c3' },
            { id: 'c9', url: URL_A }, // warning only: kept
            { description: 'no key' }
        ])
    };
    const { result: clean, stripped } = await stripBadCitations(result, lookup);

    assert.deepEqual(stripped.map(entry => entry.index), [1, 2, 4]);
    const cited = result._meta[CITATIONS_META_KEY];
    assert.deepEqual(citationsOf(clean), [cited[0], cited[3]]);
    assert.equal(clean.content![0]!.text, `Good [c1]. Fabricated. Unsafe. Unbound.\n\n[c1]: ${URL_A}`);

    const remaining = [checkBinding(clean), checkUrlPolicy(clean), await checkQuotes(clean, lookup)].flatMap(output => output.messages);
    assert.equal(remaining.filter(message => message.severity === 'error').length, 0);
});

test('filter keeps the marker a kept citation shares and returns sound results untouched', async () => {
    const lookup = async (url: string) => (url === URL_A ? 'The quick brown fox.' : undefined);
    const duplicate = { content: text(`One [c1].\n\n[c1]: ${URL_A}`), _meta: meta([{ id: 'c1' }, { id: 'c1', text: 'The fox was slow.' }]) };
    const { result: clean } = await stripBadCitations(duplicate, lookup);
    assert.deepEqual(citationsOf(clean), [{ id: 'c1' }]);
    assert.equal(clean.content![0]!.text, duplicate.content[0]!.text);

    const sound = { content: text(`One [c1].\n\n[c1]: ${URL_A}`), _meta: meta([{ id: 'c1' }]) };
    const untouched = await stripBadCitations(sound, lookup);
    assert.equal(untouched.result, sound);
    assert.deepEqual(untouched.stripped, []);
});

test('filter strips nothing for a bad link that no citation is bound to', async () => {
    const content = text('See [the portal](http://10.0.0.1/x).');
    for (const result of [{ content }, { content, _meta: meta([]) }]) {
        assert.equal(checkUrlPolicy(result).messages.length, 2);
        const stripped = await stripBadCitations(result, async () => undefined);
        assert.equal(stripped.result, result);
        assert.deepEqual(stripped.stripped, []);
    }
});

test('a failed invocation is a warning when failOpen is true and an error otherwise', () => {
    const outcome = { interceptor: 'x', mode: 'audit' as const, modeSource: 'default' as const, failOpenSource: 'default' as const, blocks: false, failure: 'crashed' };
    assert.equal(messagesOf({ ...outcome, failOpen: true })[0]!.severity, 'warn');
    assert.equal(messagesOf({ ...outcome, failOpen: false })[0]!.severity, 'error');
});

test('filter keeps the other keys of `_meta`', async () => {
    const serverInfo = { 'io.modelcontextprotocol/serverInfo': { name: 'portal-server', version: '0.1.0' } };
    const result = { content: text('One.'), _meta: { ...serverInfo, ...meta([{ description: 'no key' }]) } };
    const { result: clean } = await stripBadCitations(result, async () => undefined);
    assert.deepEqual(clean._meta, { ...serverInfo, ...meta([]) });

    const malformed = { content: text('One.'), _meta: { ...serverInfo, ...meta({ id: 'c1' }) } };
    assert.deepEqual((await stripBadCitations(malformed, async () => undefined)).result._meta, serverInfo);
});

test('binding accepts a pointer to a value in the result and needs no marker for it', () => {
    const structuredContent = { rows: [{ rate: 4.8 }], 'a/b': 1 };
    const pointers = ['/structuredContent/rows/0/rate', '/structuredContent/a~1b', '/content/0', ''];
    const result = { content: text('No markers.'), structuredContent, _meta: meta(pointers.map(pointer => ({ id: 'c1', name: 'A', pointer }))) };
    const { messages, info } = checkBinding(result);
    assert.deepEqual(messages, []);
    assert.deepEqual(info, { citations: 4, markerKeyed: 0, nameKeyed: 0, blockLevel: 0, pointerKeyed: 4 });
});

test('a pointer that names nothing is an error, and the filter removes the citation', async () => {
    const structuredContent = { rows: [{ rate: 4.8 }] };
    const pointers = ['/structuredContent/rows/1', '/structuredContent/rows/00', '/structuredContent/missing', 'structuredContent'];
    const result = {
        content: text('No markers.'),
        structuredContent,
        _meta: meta([{ name: 'Kept', pointer: '/structuredContent/rows/0' }, ...pointers.map(pointer => ({ name: 'A', pointer }))])
    };
    assert.deepEqual(
        checkBinding(result).messages.map(message => [message.path, message.severity]),
        [1, 2, 3, 4].map(index => [at(index, '.pointer'), 'error'])
    );
    const { result: clean } = await stripBadCitations(result, async () => undefined);
    assert.deepEqual(citationsOf(clean), [{ name: 'Kept', pointer: '/structuredContent/rows/0' }]);
    assert.deepEqual(clean.structuredContent, structuredContent);
});
