import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkBinding, checkQuotes, checkUrlPolicy, stripBadCitations } from '../src/citation-checks.ts';
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

test('binding rejects a non-array `citations` and a field of the wrong type', () => {
    assert.deepEqual(severities(checkBinding({ content: text('x'), citations: { id: 'c1' } }).messages), ['error']);
    const { messages } = checkBinding({ content: text('x'), citations: [{ id: 5, name: 'Five' }] });
    assert.deepEqual(messages, [{ path: 'citations[0]', message: '`id` must be a string', severity: 'error' }]);
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
        ['citations[0].url', 'citations[0].url', 'content', 'content', 'content']
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
    assert.deepEqual(info, { verified: 1, notFound: 1, unverified: 1 });
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

test('unlink removes definitions and markers and keeps link text', () => {
    const before = `One [c1]. Two [the case][c2]. Three [Named](${URL_A}). Four [c3].\n\n[c1]: ${URL_A}\n[c2]: ${URL_A}\n[c3]: ${URL_A}`;
    const after = unlink(before, new Set(['c1', 'c2']), new Set(['Named']));
    assert.equal(after, `One. Two the case. Three Named. Four [c3].\n\n[c3]: ${URL_A}`);
});

test('stripper removes citations with errors and leaves a result that passes every check', async () => {
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

test('stripper keeps the marker a kept citation shares and returns sound results untouched', async () => {
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
