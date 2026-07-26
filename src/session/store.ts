import { mkdir, readdir, stat, appendFile } from "node:fs/promises"
import path from "node:path"
import { sessionDir } from "@/config/paths"
import type { ChatItem, ModelUsage } from "@/session/messages"
import { EMPTY_USAGE } from "@/session/messages"
import type { Session } from "@/session/session"
import { recordUsage } from "@/session/session"
import { ZCodeError } from "@/util/errors"

export interface CompactionRecord {
  type: "compaction"
  summary: string
  coversUpTo: string
}

export interface MetaRecord {
  type: "meta"
  id: string
  cwd: string
  createdAt: number
}

/** Audit trail for auto mode. Not a ChatItem: it must never enter history projection. */
export interface AutoVerdictRecord {
  type: "auto-verdict"
  ts: number
  callId: string
  tool: string
  /** The command, path, or URL under review, clipped. */
  subject: string
  stage: 1 | 2
  verdict: "allow" | "block" | "unavailable"
  reason: string
  model: string
}

export interface UsageRecord extends ModelUsage {
  type: "usage"
}

export type StoreRecord = MetaRecord | ChatItem | CompactionRecord | AutoVerdictRecord | UsageRecord

export interface SessionSummary {
  id: string
  createdAt: number
  updatedAt: number
  preview: string
  file: string
}

export class SessionStore {
  private queue: Promise<void> = Promise.resolve()

  private constructor(readonly file: string) {}

  static async open(session: Session): Promise<SessionStore> {
    const dir = sessionDir(session.cwd)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `${session.id}.jsonl`)
    const store = new SessionStore(file)
    const meta: MetaRecord = { type: "meta", id: session.id, cwd: session.cwd, createdAt: session.createdAt }
    await store.write(meta)
    return store
  }

  static async reopen(cwd: string, id: string): Promise<SessionStore> {
    const dir = sessionDir(cwd)
    await mkdir(dir, { recursive: true })
    return new SessionStore(path.join(dir, `${id}.jsonl`))
  }

  private write(record: StoreRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`
    this.queue = this.queue.then(() => appendFile(this.file, line, "utf8"))
    return this.queue
  }

  async appendItem(item: ChatItem): Promise<void> {
    await this.write(item)
  }

  async appendCompaction(record: CompactionRecord): Promise<void> {
    await this.write(record)
  }

  async appendAutoVerdict(record: AutoVerdictRecord): Promise<void> {
    await this.write(record)
  }

  async appendUsage(record: UsageRecord): Promise<void> {
    await this.write(record)
  }
}

export async function listSessions(cwd: string): Promise<SessionSummary[]> {
  const dir = sessionDir(cwd)
  let files: string[]
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"))
  } catch {
    return []
  }
  const summaries: SessionSummary[] = []
  for (const name of files) {
    const file = path.join(dir, name)
    try {
      const summary = await summarize(file)
      if (summary !== null) summaries.push(summary)
    } catch {
      // skip unreadable/corrupt session file
    }
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  return summaries
}

async function summarize(file: string): Promise<SessionSummary | null> {
  const records = await readRecords(file)
  const meta = records.find((record): record is MetaRecord => record.type === "meta")
  if (meta === undefined) return null
  const firstUser = records.find((record) => record.type === "user")
  const preview =
    firstUser !== undefined && firstUser.type === "user"
      ? (firstUser.content[0]?.text ?? "").replace(/\s+/g, " ").slice(0, 60)
      : "(empty session)"
  const info = await stat(file)
  return { id: meta.id, createdAt: meta.createdAt, updatedAt: info.mtimeMs, preview, file }
}

export interface LoadedSession {
  session: Session
  compactions: CompactionRecord[]
  hasMeasuredUsageAfterLatestCompaction: boolean
}

export async function loadSession(cwd: string, id: string): Promise<LoadedSession> {
  const file = path.join(sessionDir(cwd), `${id}.jsonl`)
  if (!(await Bun.file(file).exists())) {
    throw new ZCodeError("config", `session not found: ${id}`)
  }
  const records = await readRecords(file)
  const meta = records.find((record): record is MetaRecord => record.type === "meta")
  if (meta === undefined) throw new ZCodeError("config", `session file missing metadata: ${file}`)

  const items: ChatItem[] = []
  const compactions: CompactionRecord[] = []
  let hasMeasuredUsageAfterLatestCompaction = false
  const session: Session = {
    id: meta.id,
    cwd: meta.cwd,
    createdAt: meta.createdAt,
    items,
    totalUsage: { ...EMPTY_USAGE },
    usageByModel: {},
    pendingInputs: [],
    invokedSkills: [],
  }
  for (const record of records) {
    if (record.type === "meta") continue
    if (record.type === "compaction") {
      compactions.push(record)
      hasMeasuredUsageAfterLatestCompaction = false
      continue
    }
    // Audit lines survive on disk but never reconstruct into history.
    if (record.type === "auto-verdict") continue
    if (record.type === "usage") {
      recordUsage(session, record.model, record.usage)
      continue
    }
    items.push(record)
    if (record.type === "assistant") {
      recordUsage(session, record.model, record.usage)
      if (compactions.length > 0 && record.usage.input > 0) {
        hasMeasuredUsageAfterLatestCompaction = true
      }
    }
  }

  return { session, compactions, hasMeasuredUsageAfterLatestCompaction }
}

async function readRecords(file: string): Promise<StoreRecord[]> {
  const text = await Bun.file(file).text()
  const records: StoreRecord[] = []
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue
    records.push(JSON.parse(line) as StoreRecord)
  }
  return records
}
