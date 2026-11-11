import { expect, test } from 'claude-code/testing'
import type { CommandRunInput, On } from 'claude-code'

import type { AuditReport } from '../types'

const STRIPPED: AuditReport = {
  mode: 'strip',
  outcome: 'delivered',
  content: [{ type: 'text', text: 'The rate was 4.8 percent [c1]. Youth unemployment fell.\n\n[c1]: https://data.gov.ie/dataset/mum01-seasonally-adjusted-monthly-unemployment' }],
  citations: [
    { key: 'c1', name: 'MUM01 - Seasonally Adjusted Monthly Unemployment', url: 'https://data.gov.ie/dataset/mum01-seasonally-adjusted-monthly-unemployment', status: 'kept', quote: 'verified', license: 'CC BY 4.0', credit: 'Central Statistics Office', reasons: [] },
    { key: 'c2', name: 'MUM01 - Seasonally Adjusted Monthly Unemployment', url: 'https://data.gov.ie/dataset/mum01-seasonally-adjusted-monthly-unemployment', status: 'stripped', quote: 'not found', reasons: ['quoted text does not appear'] },
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

const UNCITED: AuditReport = {
  mode: 'audit',
  outcome: 'delivered',
  content: [{ type: 'text', text: 'Consumer prices rose 2.8 percent.' }],
  citations: [],
  findings: [{ interceptor: 'citation-binding', severity: 'warn', path: 'citations', message: 'result carries no citations, so its claims cannot be traced to a source' }],
}

/** The engine stamps a run's origin and presentation; a test names the rest. */
const command = (args: string) => ({ command: 'citation-audit', args }) as CommandRunInput

/** Stands in for the engine and for src/audit-cli.ts, which prints `report`. */
function session(on: On, report: AuditReport, exitCode = 0) {
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  on('ui.status', () => ({ value: undefined }))
  on('env.get', () => ({ value: 'Windows_NT' }))
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    return { value: { exitCode, stdout: JSON.stringify(report), stderr: 'boom', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return runs
}

test('a statistics call is answered with the audited content and a note for the model', async ($, on) => {
  const runs = session(on, STRIPPED)
  const ran = await $.tool.call({ tool: 'mcp__portal__statistics', topic: 'unemployment' })

  expect(runs[0]?.argv.slice(-2)).toEqual(['src/audit-cli.ts', 'audit'])
  expect(JSON.parse(runs[0]?.stdin ?? '{}')).toEqual({ name: 'statistics', arguments: { topic: 'unemployment' } })
  expect(ran.result).toEqual(STRIPPED.content)
  expect(ran.context?.[0]).toContain('1 kept, 1 stripped')
  expect(ran.context?.[0]).toContain('- [c2] quoted text does not appear')
})

test('/citation-audit sets the mode the next call runs in', async ($, on) => {
  const runs = session(on, STRIPPED)
  expect((await $.command.run(command('strip'))).text).toBe('Citation audit mode: strip.')
  expect((await $.command.run(command('nope'))).text).toContain('Unknown mode')
  await $.tool.call({ tool: 'mcp__portal__statistics', topic: 'unemployment' })
  expect(runs[0]?.argv.at(-1)).toBe('strip')
})

test('a blocked result is refused with the interceptor error', async ($, on) => {
  session(on, BLOCKED)
  const ran = await $.tool.call({ tool: 'mcp__portal__statistics', topic: 'unemployment' })
  expect(ran.deny).toContain('Interceptor validation failed (-32602)')
  expect(ran.deny).toContain('citation-quote-check: quoted text does not appear')
})

test('a failed audit refuses the call', async ($, on) => {
  session(on, STRIPPED, 1)
  const ran = await $.tool.call({ tool: 'mcp__portal__statistics', topic: 'unemployment' })
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
  await $.tool.call({ tool: 'mcp__portal__statistics', topic: 'unemployment', tool_use_id: 'call-1' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'citation-audit',
      component: 'ToolUse',
      requestId: 'call-1',
      surface,
      props: { tool_use_id: 'call-1', tool: 'mcp__portal__statistics', input: { topic: 'unemployment' }, isRunning: false, isErrored: false, isInterrupted: false },
    })
    expect((await ui.find({ type: 'Text', text: /^citations/ }))?.text).toContain('citations')
    expect((await ui.find({ type: 'Text', text: /stripped$/ }))?.text).toBe('1 stripped')
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://data.gov.ie/dataset/mum01-seasonally-adjusted-monthly-unemployment')
    expect((await ui.find({ type: 'Text', text: /quoted text/ }))?.text).toContain('quoted text does not appear')
    await ui.unmount()
  }
})

test('the band above the prompt shows the last audit until it is hidden', async ($, on) => {
  const runs = session(on, STRIPPED)
  const props = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} }
  const mount = () => $.ui.mount({ plugin: 'citation-audit', component: 'AbovePrompt', surface: 'terminal', props })

  let ui = await mount()
  expect(await ui.find({ type: 'Text', text: /Citation audit/ })).toBeUndefined()
  await ui.unmount()

  await $.tool.call({ tool: 'mcp__portal__statistics', topic: 'unemployment', tool_use_id: 'call-1' })
  ui = await mount()
  expect((await ui.find({ type: 'Text', text: /statistics\(unemployment\)/ }))?.text).toContain('statistics(unemployment)')
  expect((await ui.find({ type: 'Text', text: /CC BY 4\.0/ }))?.text).toContain('Central Statistics Office')
  expect((await ui.find({ type: 'Link' }))?.props.label).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /stripped$/ }))?.text).toBe('1 stripped')
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://data.gov.ie/dataset/mum01-seasonally-adjusted-monthly-unemployment')
  await ui.press({ key: 'open-1' })
  expect(runs.at(-1)?.argv.at(-1)).toBe('https://data.gov.ie/dataset/mum01-seasonally-adjusted-monthly-unemployment')
  await ui.press({ key: 'hide' })
  await ui.unmount()

  ui = await mount()
  expect(await ui.find({ type: 'Text', text: /Citation audit/ })).toBeUndefined()
  await ui.unmount()
})

test('an answer with no citations is delivered with a warning', async ($, on) => {
  session(on, UNCITED)
  const ran = await $.tool.call({ tool: 'mcp__portal__statistics', topic: 'inflation', tool_use_id: 'call-2' })
  expect(ran.result).toEqual(UNCITED.content)
  expect(ran.context?.[0]).toContain('no citations')
  expect(ran.context?.[0]).toContain('- warn: result carries no citations')

  const props = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} }
  const ui = await $.ui.mount({ plugin: 'citation-audit', component: 'AbovePrompt', surface: 'terminal', props })
  expect((await ui.find({ type: 'Text', text: /^no citations$/ }))?.text).toBe('no citations')
  expect((await ui.find({ type: 'Text', text: /names no dataset/ }))?.text).toContain('cannot be traced')
  await ui.unmount()
})

test('the pane lists the last audit, on every surface', async ($, on) => {
  session(on, STRIPPED)
  await $.tool.call({ tool: 'mcp__portal__statistics', topic: 'unemployment' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'citation-audit',
      component: 'Pane',
      requestId: 'citation-audit',
      surface,
      props: { title: 'Citation audit', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /statistics\(unemployment\)/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /stripped$/ }))?.text).toBe('1 stripped')
    expect((await ui.find({ type: 'Text', text: /^quote-check/ }))?.text).toBe('quote-check ')
    await ui.unmount()
  }
})
