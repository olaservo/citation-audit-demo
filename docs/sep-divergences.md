# Where the demo differs from the SEPs, and why

The demo follows SEP-3094 (citations) at 109bbfe and SEP-2624 (interceptors) at 07c89a2. SEP-3094 was closed on 2026-11-08 after a maintainer asked that it go through a working group as an extension, so the demo treats its design as open.

## SEP-3094

| The SEP | The demo | Why |
| --- | --- | --- |
| Citations are a new top-level field on the tool result. | Citations go in the result's `_meta`. | `_meta` works today with no schema change. It also survives the [proposed new result shape](https://github.com/modelcontextprotocol/core-primitives-wg/pull/3). The SEP's author [suggested trying it](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3094#issuecomment-6401849044). |
| (Not covered.) | Citations are not attached to individual content blocks. | The proposed result shape replaces `content` and `structuredContent` with one `result` value. |
| Clients declare support with a top-level `citations` capability. | Clients declare an extension. | The SDK drops capabilities it does not know, and the maintainers want citations to be an extension. |
| Each citation can say whether it is for the user or the model (`audience`). | No `audience`. | Few clients act on it, and it will potentially be deprecated in the next protocol version. The demo decides by placement: markers in the text are for the model, citation details in `_meta` are for the host. |
| A citation is tied to a claim by a markdown link in the text. | Also allows `pointer`, a JSON Pointer to a value in the result. | Structured data has no text to put a link in. |
| No license field. | Reads `license`, and the portal can refuse a client that won't show citations. | Open data licenses often require credit. This was the use case the Open Knowledge Foundation raised. |

## SEP-2624

| The SEP | The demo | Why |
| --- | --- | --- |
| Does not say what an interceptor receives for a response. | Sends the whole tool result, including `_meta`. | The checks compare the text with the citations in `_meta`, so they need both. |
| Shows error paths as dotted names. | Uses paths like `_meta["io.modelcontextprotocol/citations"][2].url`. | The key contains dots and a slash. |
| A mutator cannot see what the validators found. | The filter runs the checks again itself. | It has no other way to know which citations failed. |

## Does the model see `_meta`?

The MCP specification does not say. MCP Apps describes `_meta` as "not intended for model context", and SEP-3094 allows a client to pass citations to the model. The demo's host does not pass them.

Claude Code 2.1.322 and 2.1.323 keep a result's `_meta` in the session record and do not show it to the model. An unknown top-level field is dropped. Details are in the [mod README](../mods/citation-audit/README.md).
