import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AuditMode, AuditRecord, AuditReport, CitationRow } from '../types'

/** A drawing surface's elements, as `$.ui.resolve` hands them. */
type Els = ReturnType<EngineInterface['ui']['resolve']>

const PANE = 'citation-audit'
const MODES: readonly AuditMode[] = ['audit', 'strip', 'block']
const MARK = { kept: '+', stripped: '-', flagged: '!' } as const
const COLOR = { kept: 'success', stripped: 'error', flagged: 'warning' } as const

const mode = atom({ plugin: 'citation-audit', key: 'mode' } as const, null as AuditMode | null)
const audits = atom({ plugin: 'citation-audit', key: 'audits' } as const, [] as AuditRecord[])
const hidden = atom({ plugin: 'citation-audit', key: 'hidden' } as const, null as string | null)

function isMode(value: unknown): value is AuditMode {
  return MODES.includes(value as AuditMode)
}

/** The mode set with /citation-audit, else the configured one. */
async function currentMode($: EngineInterface, configured: AuditMode): Promise<AuditMode> {
  return (await read($, mode)) ?? configured
}

function counts(citations: readonly CitationRow[]): string {
  if (citations.length === 0) return 'no citations'
  const of = (status: CitationRow['status']) => citations.filter(c => c.status === status).length
  return [`${of('kept')} kept`, ...(of('stripped') ? [`${of('stripped')} stripped`] : []), ...(of('flagged') ? [`${of('flagged')} flagged`] : [])].join(', ')
}

function citationLine(c: CitationRow): string {
  return [`[${c.key}]`, c.name, c.url, c.license && `license ${c.license}`, c.credit && `credit ${c.credit}`, c.quote && `quote ${c.quote}`]
    .filter(Boolean)
    .join('  ')
}

/** "audit · 2 kept, 3 flagged", each count in its status colour. */
function summary({ Text }: Els, audit: AuditRecord) {
  const of = (status: CitationRow['status']) => audit.citations.filter(c => c.status === status).length
  if (audit.outcome === 'blocked') {
    return [<Text dimColor>{audit.mode} · </Text>, <Text color="error">blocked ({audit.error?.code})</Text>]
  }
  if (audit.citations.length === 0) return [<Text dimColor>{audit.mode} · </Text>, <Text color="warning">no citations</Text>]
  return [
    <Text dimColor>{audit.mode} · </Text>,
    <Text color="success">{of('kept')} kept</Text>,
    ...(of('stripped') ? [<Text dimColor>, </Text>, <Text color="error">{of('stripped')} stripped</Text>] : []),
    ...(of('flagged') ? [<Text dimColor>, </Text>, <Text color="warning">{of('flagged')} flagged</Text>] : []),
  ]
}

/** The first reason without the URL or quote it ends in, after a count of them. */
function shortReason(reasons: readonly string[]): string {
  const first = (reasons[0] ?? '')
    .replace(/: (https?:|file:|")[\s\S]*$/, '')
    .replace(/ in https?:\S+$/, ' in the source')
    .replaceAll('`', '')
  return reasons.length > 1 ? `${reasons.length} checks failed: ${first}` : first
}

/**
 * One line per citation, the ones a check failed first. Only a citation that
 * passed every check is drawn with a link, after its license and who to
 * credit. The link has no label: a terminal without hyperlinks draws a
 * labelled link as the label and then the URL, which pushed the rest off the row.
 * An answer with no citations gets one line saying so.
 */
function citationRows({ Box, Button, Link, Text }: Els, citations: readonly CitationRow[], open?: (url: string) => void) {
  if (citations.length === 0) {
    return [
      <Box>
        <Box flexShrink={0}>
          <Text color="warning">{MARK.flagged} {'uncited'.padEnd(9)}</Text>
        </Box>
        <Text dimColor wrap="truncate-end">the answer names no dataset, so its figures cannot be traced to a source</Text>
      </Box>,
    ]
  }
  const failedFirst = [...citations].sort((a, b) => Number(a.status === 'kept') - Number(b.status === 'kept'))
  return failedFirst.map((c, i) => {
    const url = c.status === 'kept' ? c.url : undefined
    const word = c.status === 'kept' && c.quote === 'verified' ? 'verified' : c.status
    // A citation with no id is keyed by its name: show the name once.
    const key = c.key === c.name ? '' : `[${c.key}]`
    const label = [key, c.name].filter(Boolean).join(' ')
    return (
      <Box>
        <Box flexShrink={0}>
          <Text color={COLOR[c.status]}>
            {MARK[c.status]} {word.padEnd(9)}
          </Text>
        </Box>
        {open && url && (
          <Box flexShrink={0} marginRight={1}>
            <Button key={`open-${i}`} label="open" onPress={() => open(url)} />
          </Box>
        )}
        {c.status === 'kept' ? (
          <Text wrap="truncate-end">
            {label}
            <Text dimColor>{[c.license, c.credit].map(part => (part ? ` · ${part}` : '')).join('')}</Text>
            {c.url && <Text dimColor> · </Text>}
            {c.url && <Link href={c.url} />}
          </Text>
        ) : (
          [
            <Box flexShrink={0}>
              <Text>{label}</Text>
            </Box>,
            <Text dimColor wrap="truncate-end">
              {' · '}
              {shortReason(c.reasons)}
            </Text>,
          ]
        )}
      </Box>
    )
  })
}

/**
 * Opens a URL in the person's browser. A row may cut a long URL short, and a
 * terminal that finds links in the text then opens the shortened address.
 */
async function openUrl($: EngineInterface, url: string): Promise<void> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  // Neither form passes the URL through a shell's parser.
  const argv = isWindows ? ['rundll32', 'url.dll,FileProtocolHandler', url] : ['sh', '-c', 'open "$0" 2>/dev/null || xdg-open "$0"', url]
  const ran = await $.process.run(argv, { timeoutMs: 10_000 })
  if (ran.exitCode !== 0) $.ui.toast(`Could not open ${url}`)
}

/**
 * Runs the host in src/audit-cli.ts: it calls the tool itself, as a client
 * that declares citations, and runs the interceptors over the result. Claude
 * Code's own MCP client drops the top-level `citations` field.
 */
async function runAudit($: EngineInterface, dir: string, current: AuditMode, args: Record<string, unknown>): Promise<AuditReport> {
  const ran = await $.process.run(['node', '--import', 'tsx', 'src/audit-cli.ts', current], {
    cwd: dir,
    stdin: JSON.stringify({ name: 'statistics', arguments: args }),
    timeoutMs: 60_000,
  })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim().split('\n').pop() || `audit-cli exited ${ran.exitCode}`)
  return JSON.parse(ran.stdout) as AuditReport
}

/** What the model reads after the result: Claude Code passes it no citations. */
function contextFor(report: AuditReport): string {
  const by = (status: CitationRow['status']) => report.citations.filter(c => c.status === status)
  const withReasons = (c: CitationRow) => `- [${c.key}] ${c.reasons.join('; ')}`
  // A marker with no entry is a finding on `content`, not on a citation.
  const other = report.findings.filter(f => f.severity !== 'info' && !f.path?.startsWith('citations['))
  return [
    `Citation audit (mode ${report.mode}): ${counts(report.citations)}.`,
    ...(by('kept').length ? ['Citations delivered with this result:', ...by('kept').map(c => `- ${citationLine(c)}`)] : []),
    ...(by('stripped').length
      ? ['Removed from the result because a check failed. Those claims are now uncited, so do not present them as sourced:', ...by('stripped').map(withReasons)]
      : []),
    ...(by('flagged').length ? ['Delivered, but a check failed. Say so if you rely on them:', ...by('flagged').map(withReasons)] : []),
    ...(other.length ? ['Findings about the text:', ...other.map(f => `- ${f.severity}: ${f.message}`)] : []),
  ].join('\n')
}

export const register: Register = (on, options) => {
  const tool = `mcp__${String(options.server || 'portal')}__statistics`
  const configured: AuditMode = isMode(options.mode) ? options.mode : 'audit'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'citation-audit',
      description: 'Show the citation audits in a pane, or set the mode',
      argumentHint: '[audit|strip|block]',
    })
    $.ui.status(await currentMode($, configured))
    return next(e)
  })

  on('command.run', { command: 'citation-audit' }, async ($, e) => {
    const wanted = e.args.trim()
    if (wanted === '') {
      await $.ui.open({ id: PANE, title: 'Citation audit' })
      return { text: `Citation audit pane opened. Mode: ${await currentMode($, configured)}.` }
    }
    if (!isMode(wanted)) return { text: `Unknown mode "${wanted}". Use audit, strip, or block.` }
    await update($, mode, () => wanted)
    $.ui.status(wanted)
    return { text: `Citation audit mode: ${wanted}.` }
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool !== tool) return next(e)
    const { tool: _tool, tool_use_id: id, agentId: _agent, requestMeta: _meta, ...args } = e as unknown as Record<string, unknown> & { tool_use_id: string }
    const current = await currentMode($, configured)
    const dir = String(options.demoDir || `${$.plugin.root}/../..`)

    let report: AuditReport
    try {
      report = await runAudit($, dir, current, args)
    } catch (err) {
      return { deny: `citation-audit: the audit could not run: ${err instanceof Error ? err.message : String(err)}` }
    }

    const { content, ...kept } = report
    await update($, audits, list => [...list, { ...kept, id, topic: String(args.topic ?? '') }].slice(-50))
    await update($, hidden, () => null)
    $.ui.status(`${current} · ${report.outcome === 'blocked' ? 'blocked' : counts(report.citations)}`)

    if (report.outcome === 'blocked' || !content) {
      const { code, message, reasons } = report.error ?? { code: 0, message: 'Blocked', reasons: [] }
      return { deny: [`${message} (${code}). The result was not delivered.`, ...reasons].join('\n') }
    }
    return { result: content, context: [contextFor(report)] }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'citation-audit: its hook failed.' }))

  // The audited citations, under the tool call's own row.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const row = await next(e)
    const audit = (await read($, audits)).find(a => a.id === e.requestId)
    if (!audit) return row
    const els = $.ui.resolve(e)
    const { Box, Text } = els

    return (
      <Box flexDirection="column">
        {row}
        <Box flexDirection="column" marginLeft={2}>
          <Box>
            <Text dimColor>citations · </Text>
            {summary(els, audit)}
          </Box>
          {citationRows(els, audit.citations)}
        </Box>
      </Box>
    )
  })

  // The transcript folds finished calls into one count line. Unfold a group
  // that holds a statistics call, so its row and citations stay on screen.
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) =>
    e.props.calls.some(c => c.tool === tool) ? next({ ...e, props: { ...e.props, isExpanded: true } }) : next(e),
  )

  // The last audit, above the prompt until the person hides it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const last = (await read($, audits)).at(-1)
    if (e.props.hasSurvey || !last || (await read($, hidden)) === last.id) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const buttons = (
      <Box flexShrink={0} marginLeft={1}>
        <Button key="details" label="Details" onPress={() => $.ui.open({ id: PANE, title: 'Citation audit' })} />
        <Button key="hide" label="Hide" onPress={() => update($, hidden, () => last.id)} />
      </Box>
    )
    // The band may be three rows tall, so the buttons share the first row
    // where it is wide enough to hold them.
    const isWide = e.props.bodyColumns >= 80

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>Citations </Text>
          <Text dimColor>statistics({last.topic}) · </Text>
          {summary(els, last)}
          {isWide && buttons}
        </Box>
        {citationRows(els, last.citations, url => openUrl($, url))}
        {!isWide && buttons}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const current = await currentMode($, configured)
    const list = await read($, audits)
    const last = list.at(-1)

    return (
      <Box flexDirection="column">
        <Box>
          {MODES.map((m, i) => (
            <Button key={`mode-${m}`} label={m} hotkey={String(i + 1)} variant={m === current ? 'primary' : 'secondary'} onPress={() => update($, mode, () => m)} />
          ))}
        </Box>
        {!last && <Text dimColor>No audits yet. Ask for statistics on population, unemployment, or inflation.</Text>}
        {last && (
          <Box flexDirection="column">
            <Box>
              <Text bold>statistics({last.topic}) </Text>
              {summary(els, last)}
            </Box>
            {citationRows(els, last.citations, url => openUrl($, url))}
            <Text dimColor>{last.findings.length ? 'Findings' : 'No findings.'}</Text>
            {last.findings.map(f => (
              <Box>
                <Box flexShrink={0}>
                  <Text color={f.severity === 'error' ? 'error' : f.severity === 'warn' ? 'warning' : undefined}>{f.severity.padEnd(6)}</Text>
                  <Text>{f.interceptor.replace('citation-', '')} </Text>
                </Box>
                <Text dimColor wrap="truncate-end">
                  {f.path ?? ''} · {f.message}
                </Text>
              </Box>
            ))}
            <Text dimColor>{list.length} audited calls this session.</Text>
          </Box>
        )}
      </Box>
    )
  })
}
