export type AuditMode = 'audit' | 'strip' | 'block'

/** One validation message from an interceptor (SEP-2624). */
export type Finding = {
  interceptor: string
  severity: 'info' | 'warn' | 'error'
  path?: string
  message: string
}

export type CitationRow = {
  /** The citation's `id`, else its `name`, else its index. */
  key: string
  name?: string
  url?: string
  /** `flagged`: a check reported an error and the citation was not removed. */
  status: 'kept' | 'stripped' | 'flagged'
  quote?: 'verified' | 'not found' | 'unverified'
  reasons: string[]
}

/** What `src/audit-cli.ts` prints for one tool call. */
export type AuditReport = {
  mode: AuditMode
  outcome: 'delivered' | 'blocked'
  content?: { type: string; text?: string }[]
  /** `reasons`: the errors of the validators that blocked. */
  error?: { code: number; message: string; reasons: string[] }
  citations: CitationRow[]
  findings: Finding[]
}

/** A report as the mod keeps it, under the tool call's id. */
export type AuditRecord = Omit<AuditReport, 'content'> & { id: string; topic: string }

declare module 'claude-code' {
  interface PluginState {
    'citation-audit': {
      /** The mode set with /citation-audit; null: the configured one. */
      mode: AuditMode | null
      audits: AuditRecord[]
      /** The id of the audit whose band the person hid. */
      hidden: string | null
    }
  }
}
