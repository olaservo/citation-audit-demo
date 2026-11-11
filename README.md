# Citation audit demo

Audits the citations on MCP tool results with interceptors. A host calls a tool, receives a result carrying SEP-3094 citations, and runs three validators and one mutator from an Interceptor Server over it on the `tools/call` response phase before delivering it. The validators report bad citations and the mutator strips them.

- Interceptors: [SEP-2624](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2624) as synced in [Degiorgio/modelcontextprotocol#3](https://github.com/Degiorgio/modelcontextprotocol/pull/3) (commit 32f00d8, `docs/sep.md` at 07c89a2 in experimental-ext-interceptors).
- Citations: [SEP-3094](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3094) at 109bbfe.
- SDK: `@modelcontextprotocol/client` and `@modelcontextprotocol/server` 2.4.0, protocol 2026-07-28, stdio.

## Run

```
npm install
npm run demo
npm test
```

Requires Node 24 or later.

## Processes

| Process | File | Role |
| --- | --- | --- |
| Host | `src/demo.ts` | MCP client of both servers. Invoker in SEP-2624 terms. |
| Research server | `src/research-server.ts` | Ordinary MCP server. Its `research` tool returns text with markdown citation markers and a top-level `citations` array. |
| Interceptor Server | `src/interceptor-server.ts` | Serves `interceptors/list` and `interceptor/invoke`. Hosts no tools, prompts, or resources. |

The Interceptor Server sits beside the host and is not in the path between the host and the research server.

```mermaid
sequenceDiagram
    participant H as Host
    participant R as Research server
    participant I as Interceptor Server
    H->>R: tools/call research
    R-->>H: text and citations
    par each of the three validators
        H->>I: interceptor/invoke
        I-->>H: valid, messages
    end
    alt an active validator reports an error
        Note over H: block with -32602
    else
        H->>I: interceptor/invoke citation-stripper
        I-->>H: modified, payload
        Note over H: deliver the result
    end
```

## Interceptors

All four hook `tools/call`, phase `response`, and declare `mode: "audit"`.

| Name | Type | Does | Config |
| --- | --- | --- | --- |
| `citation-binding` | validation | Every entry has one of `id`, `name`, `url`. Ids are unique. Each id has a marker in the text and a destination. Markers shaped like citation ids have an entry. | none |
| `citation-url-policy` | validation | `url`, `thumbnailUrl`, and markdown destinations use an allowed scheme and do not point at private, loopback, or link-local addresses (SEP-3094 "Dereferencing citation URIs"). | `allowedSchemes`, default `["https"]` |
| `citation-quote-check` | validation | A citation's quoted `text` appears in the cited source. Declares `failOpen: true`. | `unverifiedSeverity`, default `"info"` |
| `citation-stripper` | mutation | Removes every citation the three checks report at severity `error`, with its marker and link definition in the text. `priorityHint: -10000`. | `allowedSchemes`, default `["https"]` |

The checks and the strip are plain functions in `src/citation-checks.ts`.

The stripper removes the citation and leaves the claim in the text uncited. Link text is kept as plain text. Findings at `warn` or `info` do not strip, so a marker with no entry (`[c3]` in the demo) stays.

## What the demo shows

The host follows the receiving order from SEP-2624: validate in parallel, then mutate in sequence if validation did not block.

1. `research(judicial-review)` returns sound citations in all three link forms. All validators pass and the stripper returns `modified: false`.
2. `research(severance)` returns flawed citations: a quote the source does not contain, a marker with no entry, an entry with no marker, an entry with no `id`, `name`, or `url`, a link-local destination, and a `file:` thumbnail. With the server-declared audit mode the findings are logged, the stripper computes a shadow mutation that is not applied, and the result is delivered unchanged.
3. The same call with an invoker override that promotes `citation-stripper` to `active`. Three of five citations are stripped and the result is delivered with the remaining two.
4. The same call with `citation-url-policy` and `citation-quote-check` also promoted to `active`. The result is blocked with `-32602 Interceptor validation failed` and the stripper does not run.

Each line of output records the resolved `mode` and `failOpen` and marks the values that came from an invoker override, as SEP-2624 "Security Best Practices" asks.

## Where the demo fills a gap or departs from the SEPs

- SEP-2624 does not define the payload for the response phase. The demo passes the `tools/call` result object.
- SEP-3094 declares the client capability as a top-level `citations` key in `clientCapabilities`. The SDK drops capability keys it does not know. The demo declares `extensions["io.modelcontextprotocol/citations"] = { render: {} }` instead. The research server omits `citations` when the client does not declare it.
- The top-level `citations` field on the tool result passes through the SDK on both the server and the client unchanged.
- `citation-quote-check` reads snapshots from `corpus/` keyed by URL and makes no network requests. The handbook source is fictional.
- `citation-url-policy` checks the host as written. It does not resolve DNS names, so a public name that resolves to a private address passes.
- With one mutator, priority ordering and passing each mutation's output to the next are implemented in `src/invoker.ts` but not exercised.
- The stripper reruns the three checks itself. SEP-2624 gives a mutator no access to validator results, and interceptor state propagation is listed as future work.
- `src/markdown-links.ts` is a small scanner, not a CommonMark parser. It does not skip code spans.
