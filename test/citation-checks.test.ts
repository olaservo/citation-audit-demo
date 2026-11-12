import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkBinding, checkLicense, checkQuotes, checkUrlPolicy, listCitations, stripBadCitations } from '../src/citation-checks.ts';
import { report } from '../src/host.ts';
import { messagesOf } from '../src/invoker.ts';
import { parseLinks, unlink } from '../src/markdown-links.ts';

const URL_A = 'https://example.com/a';
const text = (value: string) => [{ type: 'text', text: value }];
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
        citations: [{ id: 'c1' }, { id: 'c2' }, { name: 'Named' }]
    };
    const { messages, info } = checkBinding(result);
    assert.deepEqual(messages, []);
    assert.deepEqual(info, { citations: 3, markerKeyed: 2, nameKeyed: 1, blockLevel: 0 });
});

test('binding treats an unmatched name as a block-level citation', () => {
    const { messages, info } = checkBinding({ content: text('No markers.'), citations: [{ name: 'Whole answer', url: URL_A }] });
    assert.deepEqual(messages, []);
    assert.equal(info.blockLevel, 1);
});

test('binding reports empty, duplicate, unbound, and dangling entries, and only an empty entry is an error', () => {
    const { messages } = checkBinding({
        content: text(`One [c1]. Two [c2]. Three [c3].\n\n[c1]: ${URL_A}`),
        citations: [{ id: 'c1' }, { id: 'c1' }, { id: 'c2' }, { id: 'c9', url: URL_A }, { description: 'nothing else' }]
    });
    assert.deepEqual(
        messages.map(message => [message.path, message.severity]),
        [
            ['citations[1].id', 'warn'], // duplicate
            ['citations[2]', 'warn'], // c2 has no destination
            ['citations[3].id', 'warn'], // c9 has no marker
            ['citations[4]', 'error'], // none of id, name, url
            ['content', 'warn'] // [c3] has no citation
        ]
    );
});

test('binding counts an id with no marker as block-level', () => {
    const { info } = checkBinding({ content: text(`One [c1].\n\n[c1]: ${URL_A}`), citations: [{ id: 'c1' }, { id: 'c2', url: URL_A }] });
    assert.deepEqual(info, { citations: 2, markerKeyed: 1, nameKeyed: 0, blockLevel: 1 });
});

test('only the binding check rejects a non-array `citations` and a field of the wrong type', async () => {
    assert.deepEqual(severities(checkBinding({ content: text('x'), citations: { id: 'c1' } }).messages), ['error']);
    const result = { content: text('x'), citations: [{ id: 5, name: 'Five' }] };
    assert.deepEqual(checkBinding(result).messages, [{ path: 'citations[0]', message: '`id` must be a string', severity: 'error' }]);
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
    const { messages } = checkUrlPolicy({ citations: urls.map(url => ({ url })) });
    assert.deepEqual(
        messages.map(message => message.path),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(index => `citations[${index}].url`)
    );
});

test('url policy checks the markdown destination of a minimalist citation and honours allowedSchemes', () => {
    const result = { content: text('Claim [c1].\n\n[c1]: http://example.com/a'), citations: [{ id: 'c1' }] };
    assert.equal(checkUrlPolicy(result).messages.length, 1);
    assert.equal(checkUrlPolicy(result, { allowedSchemes: ['https', 'http'] }).messages.length, 0);
});

test('url policy checks the markdown link beside a citation url, and links no citation is bound to', () => {
    const result = {
        content: text(`One [c1]. See [here](http://localhost/x).\n\n[c1]: http://169.254.169.254/x\n[other]: file:///etc/passwd`),
        citations: [{ id: 'c1', url: URL_A }]
    };
    assert.deepEqual(
        checkUrlPolicy(result).messages.map(message => message.path),
        ['citations[0]', 'citations[0]', 'content', 'content', 'content']
    );
});

test('quote check verifies, rejects, and reports unverifiable quotes', async () => {
    const lookup = async (url: string) => (url === URL_A ? 'The  quick brown fox\njumps over the lazy dog.' : undefined);
    const result = {
        content: text(`One [c1].\n\n[c1]: ${URL_A}#section`),
        citations: [
            { id: 'c1', text: 'quick brown fox jumps' },
            { name: 'B', url: `${URL_A}#:~:text=x`, text: 'The fox was slow.' },
            { name: 'C', url: 'https://example.com/unknown', text: 'anything' }
        ]
    };
    const { messages, info } = await checkQuotes(result, lookup);
    assert.deepEqual(info, { verified: 1, notFound: 1, unverified: 1, quotes: { 0: 'verified', 1: 'not found', 2: 'unverified' } });
    assert.deepEqual(
        messages.map(message => [message.path, message.severity]),
        [
            ['citations[1].text', 'error'],
            ['citations[2].text', 'info']
        ]
    );
    const strict = await checkQuotes(result, lookup, { unverifiedSeverity: 'warn' });
    assert.equal(strict.messages[1]!.severity, 'warn');
});

test('report labels an unverifiable quote unverified at any severity', async () => {
    const lookup = async () => undefined;
    const result = { content: text('One.'), citations: [{ name: 'A', url: URL_A, text: 'quoted' }] };
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
    const result = { content: text('One.'), citations: [{ name: 'A', url: URL_A, text: 'quoted' }, { name: 'B', url: URL_A }] };
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
    const result = { content: text('One.'), citations: [{ id: 5, name: 'Five' }, null] };
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
    for (const result of [{ content: text('A figure.') }, { content: text('A figure.'), citations: [] }]) {
        assert.deepEqual(checkBinding(result).messages, []);
        assert.deepEqual(
            checkBinding(result, { uncitedSeverity: 'warn' }).messages.map(message => [message.path, message.severity]),
            [['citations', 'warn']]
        );
    }
    assert.deepEqual(checkBinding({ content: text('x'), citations: [{ name: 'A', url: URL_A }] }, { uncitedSeverity: 'warn' }).messages, []);
});

test('license check wants a license, and someone to credit when the license requires it', () => {
    const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';
    const result = {
        content: text('No markers.'),
        citations: [
            { name: 'A', license: CC_BY, publisher: { type: 'Organization', name: 'Office' } },
            { name: 'B', license: 'ODbL-1.0', author: [{ name: 'Someone' }] },
            { name: 'C', license: 'https://creativecommons.org/publicdomain/zero/1.0/' },
            { name: 'D', license: CC_BY, publisher: { name: ' ' } },
            { name: 'E' },
            { description: 'left to the binding check' }
        ]
    };
    const { messages, info } = checkLicense(result);
    assert.deepEqual(info, { licensed: 3, unlicensed: 1, uncredited: 1 });
    assert.deepEqual(
        messages.map(message => [message.path, message.severity]),
        [
            ['citations[3].license', 'error'],
            ['citations[4].license', 'error']
        ]
    );
    assert.equal(checkLicense(result, { missingSeverity: 'warn' }).messages[1]!.severity, 'warn');
    assert.deepEqual(
        listCitations(result).map(citation => citation.credit),
        ['Office', 'Someone', undefined, undefined, undefined, undefined]
    );
});

test('filter leaves a citation whose only error is its license', async () => {
    const result = { content: text(`One [c1].\n\n[c1]: ${URL_A}`), citations: [{ id: 'c1' }] };
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
        citations: [
            { id: 'c1', text: 'quick brown fox' },
            { id: 'c2', text: 'The fox was slow.' },
            { id: 'c3' },
            { id: 'c9', url: URL_A }, // warning only: kept
            { description: 'no key' }
        ]
    };
    const { result: clean, stripped } = await stripBadCitations(result, lookup);

    assert.deepEqual(stripped.map(entry => entry.index), [1, 2, 4]);
    assert.deepEqual(clean.citations, [result.citations[0], result.citations[3]]);
    assert.equal(clean.content![0]!.text, `Good [c1]. Fabricated. Unsafe. Unbound.\n\n[c1]: ${URL_A}`);

    const remaining = [checkBinding(clean), checkUrlPolicy(clean), await checkQuotes(clean, lookup)].flatMap(output => output.messages);
    assert.equal(remaining.filter(message => message.severity === 'error').length, 0);
});

test('filter keeps the marker a kept citation shares and returns sound results untouched', async () => {
    const lookup = async (url: string) => (url === URL_A ? 'The quick brown fox.' : undefined);
    const duplicate = { content: text(`One [c1].\n\n[c1]: ${URL_A}`), citations: [{ id: 'c1' }, { id: 'c1', text: 'The fox was slow.' }] };
    const { result: clean } = await stripBadCitations(duplicate, lookup);
    assert.deepEqual(clean.citations, [{ id: 'c1' }]);
    assert.equal(clean.content![0]!.text, duplicate.content[0]!.text);

    const sound = { content: text(`One [c1].\n\n[c1]: ${URL_A}`), citations: [{ id: 'c1' }] };
    const untouched = await stripBadCitations(sound, lookup);
    assert.equal(untouched.result, sound);
    assert.deepEqual(untouched.stripped, []);
});

test('filter strips nothing for a bad link that no citation is bound to', async () => {
    const content = text('See [the portal](http://10.0.0.1/x).');
    for (const result of [{ content }, { content, citations: [] }]) {
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
