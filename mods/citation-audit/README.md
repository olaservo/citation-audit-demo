# citation-audit mod for Claude Code

Makes Claude Code the host in the [citation audit demo](../../README.md). Written against Claude Code 2.1.322.

## Install

The mod runs the demo's own code, so it needs a clone with `npm install` done. Start Claude Code in the clone so `.mcp.json` adds the portal server, then load the mod:

```
# for this session only
claude --plugin-dir mods/citation-audit

# or install it from this repo's marketplace
/plugin marketplace add olaservo/citation-audit-demo
/plugin install citation-audit@citation-audit-demo
```

To start Claude Code somewhere else, set the mod's `demoDir` option to the clone and add the portal server to that session's MCP config.

## Use

Ask for statistics on `unemployment`, `population`, or `inflation`.

- The model receives the audited text and a note listing which citations passed, were stripped, or were flagged.
- A band above the prompt shows the last audit, one line per citation. Only a passed citation is drawn as a link, with its license, who to credit, and an `open` button.
- The same lines appear under the tool call's row.
- An answer with no citations gets a warning line.
- `/citation-audit` opens a pane with the findings. `/citation-audit audit`, `strip`, or `block` sets the mode, matching scenarios 2 to 4 in the main README.
- In `block` mode the model receives the `-32602` error in place of the result.

`npm run test:mod` runs the mod's tests.

## How it works

Claude Code's MCP client drops the top-level `citations` field: a mod's `tool.call` hook and `$.mcp.call` both receive `content` only (observed on 2.1.322). A mod also cannot send `interceptor/invoke`. So the mod's `tool.call` hook answers each `statistics` call by running `src/audit-cli.ts`, which calls the tool as a client that declares citations, runs the interceptors, and prints a report. The portal server in `.mcp.json` only lists the tool for the model. Each call starts three Node processes.

`types/index.d.ts` copies the report types from `src/host.ts`, since an installed mod has no access to `src/`. Keep the two in step.
