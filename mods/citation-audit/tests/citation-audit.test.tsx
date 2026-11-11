import { expect, test } from 'claude-code/testing'
import type { CommandRunInput, On } from 'claude-code'

import type { AuditReport } from '../types'

const STRIPPED: AuditReport = {
  mode: 'strip',
  outcome: 'delivered',
  content: [{ type: 'text', text: 'Four weeks per year [c1]. Doubled after ten years.\n\n[c1]: https://handbook.example.com/a' }],
  citations: [
    { key: 'c1', name: 'Employee Handbook', url: 'https://handbook.example.com/a', status: 'kept', quote: 'verified', reasons: [] },
    { key: 'c2', name: 'Employee Handbook', url: 'https://handbook.example.com/a', status: 'stripped', quote: 'not found', reasons: ['quoted text does not appear'] },
  ],
  findings: [{ interceptor: 'citation-quote-check', severity: 'error', path: 'citations[1].text', message: 'quoted text does not appear' }],
}

const BLOCKED: AuditReport = {
  mode: 'block',
  outcome: 'blocked',
  error: { code: -32602, message: 'Interceptor validation failed', reasons: ['citation-quote-check: quoted text does not appear'] },
  citations: [{ ...STRIPPED.citations[1]!, status: 'flagged' }],
  findings: STRIPPED.findings,
}

/** The engine stamps a run's origin and presentation; a test names the rest. */
const command = (args: string) => ({ command: 'citation-audit', args }) as CommandRunInput

/** Stands in for the engine and for src/audit-cli.ts, which prints `report`. */
function session(on: On, report: AuditReport, exitCode = 0) {
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    return { value: { exitCode, stdout: JSON.stringify(report), stderr: 'boom', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return runs
}

test('a research call is answered with the audited content and a note for the model', async ($, on) => {
  const runs = session(on, STRIPPED)
  const ran = await $.tool.call({ tool: 'mcp__research__research', topic: 'severance' })

  expect(runs[0]?.argv.slice(-2)).toEqual(['src/audit-cli.ts', 'audit'])
  expect(JSON.parse(runs[0]?.stdin ?? '{}')).toEqual({ name: 'research', arguments: { topic: 'severance' } })
  expect(ran.result).toEqual(STRIPPED.content)
  expect(ran.context?.[0]).toContain('1 kept, 1 stripped')
  expect(ran.context?.[0]).toContain('- [c2] quoted text does not appear')
})

test('/citation-audit sets the mode the next call runs in', async ($, on) => {
  const runs = session(on, STRIPPED)
  expect((await $.command.run(command('strip'))).text).toBe('Citation audit mode: strip.')
  expect((await $.command.run(command('nope'))).text).toContain('Unknown mode')
  await $.tool.call({ tool: 'mcp__research__research', topic: 'severance' })
  expect(runs[0]?.argv.at(-1)).toBe('strip')
})

test('a blocked result is refused with the interceptor error', async ($, on) => {
  session(on, BLOCKED)
  const ran = await $.tool.call({ tool: 'mcp__research__research', topic: 'severance' })
  expect(ran.deny).toContain('Interceptor validation failed (-32602)')
  expect(ran.deny).toContain('citation-quote-check: quoted text does not appear')
})

test('a failed audit refuses the call', async ($, on) => {
  session(on, STRIPPED, 1)
  const ran = await $.tool.call({ tool: 'mcp__research__research', topic: 'severance' })
  expect(ran.deny).toContain('the audit could not run: boom')
})

test('other tools are left alone', async ($, on) => {
  const runs = session(on, STRIPPED)
  on('tool.call', () => ({ result: 'untouched' }))
  const ran = await $.tool.call({ tool: 'mcp__other__lookup', q: 'x' })
  expect(ran.result).toBe('untouched')
  expect(runs.length).toBe(0)
})

test('the tool row lists the citations and links only a kept one', async ($, on) => {
  session(on, STRIPPED)
  await $.tool.call({ tool: 'mcp__research__research', topic: 'severance', tool_use_id: 'call-1' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'citation-audit',
      component: 'ToolUse',
      requestId: 'call-1',
      surface,
      props: { tool_use_id: 'call-1', tool: 'mcp__research__research', input: { topic: 'severance' }, isRunning: false, isErrored: false, isInterrupted: false },
    })
    expect((await ui.find({ type: 'Text', text: /^citations/ }))?.text).toContain('strip · 1 kept, 1 stripped')
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://handbook.example.com/a')
    expect((await ui.find({ type: 'Text', text: /stripped: / }))?.text).toContain('quoted text does not appear')
    await ui.unmount()
  }
})

test('the pane lists the last audit, on every surface', async ($, on) => {
  session(on, STRIPPED)
  await $.tool.call({ tool: 'mcp__research__research', topic: 'severance' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'citation-audit',
      component: 'Pane',
      requestId: 'citation-audit',
      surface,
      props: { title: 'Citation audit', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect((await ui.find({ type: 'Text', text: /research\(severance\)/ }))?.text).toContain('strip · delivered')
    expect((await ui.find({ type: 'Text', text: /^- \[c2\]/ }))?.text).toContain('quote not found')
    await ui.unmount()
  }
})
