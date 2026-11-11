import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AuditMode, AuditRecord, AuditReport, CitationRow } from '../types'

const PANE = 'citation-audit'
const MODES: readonly AuditMode[] = ['audit', 'strip', 'block']
const MARK = { kept: '+', stripped: '-', flagged: '!' } as const
const COLOR = { kept: 'success', stripped: 'error', flagged: 'warning' } as const

const mode = atom({ plugin: 'citation-audit', key: 'mode' } as const, null as AuditMode | null)
const audits = atom({ plugin: 'citation-audit', key: 'audits' } as const, [] as AuditRecord[])

function isMode(value: unknown): value is AuditMode {
  return MODES.includes(value as AuditMode)
}

/** The mode set with /citation-audit, else the configured one. */
async function currentMode($: EngineInterface, configured: AuditMode): Promise<AuditMode> {
  return (await read($, mode)) ?? configured
}

function counts(citations: readonly CitationRow[]): string {
  const of = (status: CitationRow['status']) => citations.filter(c => c.status === status).length
  return [`${of('kept')} kept`, ...(of('stripped') ? [`${of('stripped')} stripped`] : []), ...(of('flagged') ? [`${of('flagged')} flagged`] : [])].join(', ')
}

function citationLine(c: CitationRow): string {
  return [`[${c.key}]`, c.name, c.url, c.quote && `quote ${c.quote}`].filter(Boolean).join('  ')
}

/**
 * Runs the host in src/audit-cli.ts: it calls the tool itself, as a client
 * that declares citations, and runs the interceptors over the result. Claude
 * Code's own MCP client drops the top-level `citations` field.
 */
async function runAudit($: EngineInterface, dir: string, current: AuditMode, args: Record<string, unknown>): Promise<AuditReport> {
  const ran = await $.process.run(['node', '--import', 'tsx', 'src/audit-cli.ts', current], {
    cwd: dir,
    stdin: JSON.stringify({ name: 'research', arguments: args }),
    timeoutMs: 60_000,
  })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim().split('\n').pop() || `audit-cli exited ${ran.exitCode}`)
  return JSON.parse(ran.stdout) as AuditReport
}

/** What the model reads after the result: Claude Code passes it no citations. */
function contextFor(report: AuditReport): string {
  const by = (status: CitationRow['status']) => report.citations.filter(c => c.status === status)
  const withReasons = (c: CitationRow) => `- [${c.key}] ${c.reasons.join('; ')}`
  return [
    `Citation audit (mode ${report.mode}): ${counts(report.citations)}.`,
    ...(by('kept').length ? ['Citations delivered with this result:', ...by('kept').map(c => `- ${citationLine(c)}`)] : []),
    ...(by('stripped').length
      ? ['Removed from the result because a check failed. Those claims are now uncited, so do not present them as sourced:', ...by('stripped').map(withReasons)]
      : []),
    ...(by('flagged').length ? ['Delivered, but a check failed. Say so if you rely on them:', ...by('flagged').map(withReasons)] : []),
  ].join('\n')
}

export const register: Register = (on, options) => {
  const tool = `mcp__${String(options.server || 'research')}__research`
  const configured: AuditMode = isMode(options.mode) ? options.mode : 'audit'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'citation-audit',
      description: 'Show the citation audits in a pane, or set the mode',
      argumentHint: '[audit|strip|block]',
    })
    $.ui.status(`citations: ${await currentMode($, configured)}`)
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
    $.ui.status(`citations: ${wanted}`)
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
    $.ui.status(`citations: ${current} · ${report.outcome === 'blocked' ? 'blocked' : counts(report.citations)}`)

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
    const { Box, Link, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {row}
        <Box flexDirection="column" marginLeft={2}>
          <Text dimColor>
            citations · {audit.mode} · {audit.outcome === 'blocked' ? `blocked (${audit.error?.code})` : counts(audit.citations)}
          </Text>
          {audit.citations.map(c => (
            <Box>
              <Text color={COLOR[c.status]}>{MARK[c.status]} </Text>
              {/* Only a citation that passed every check is drawn as a link. */}
              {c.status === 'kept' && c.url ? <Link href={c.url} label={`[${c.key}] ${c.name ?? c.url}`} /> : <Text>{`[${c.key}] ${c.name ?? ''}`}</Text>}
              <Text dimColor>{c.status === 'kept' ? (c.quote ? `  quote ${c.quote}` : '') : `  ${c.status}: ${c.reasons[0] ?? ''}`}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
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
        {!last && <Text dimColor>No audits yet. Ask for research on judicial-review or severance.</Text>}
        {last && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              research({last.topic}) · {last.mode} · {last.outcome}
            </Text>
            {last.citations.map(c => (
              <Text color={COLOR[c.status]}>
                {MARK[c.status]} {citationLine(c)}
              </Text>
            ))}
            <Text dimColor>{last.findings.length ? 'Findings' : 'No findings.'}</Text>
            {last.findings.map(f => (
              <Text color={f.severity === 'error' ? 'error' : f.severity === 'warn' ? 'warning' : undefined}>
                {f.severity.padEnd(5)} {f.interceptor}  {f.path ?? ''}  {f.message}
              </Text>
            ))}
            <Text dimColor>{list.length} audited calls this session.</Text>
          </Box>
        )}
      </Box>
    )
  })
}
