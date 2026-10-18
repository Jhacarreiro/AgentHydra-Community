// The core's store (core/README.md): chats.json holds every chat's summary, chats/<id>.jsonl its transcript, one
// TranscriptItem per line. An item written again under the same id appends a new line; load keeps the last version of
// each id, in the order it first appeared. Every write is synchronous, so writes never interleave.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChatSummary, TranscriptItem } from './types'

export class Store {
  readonly home: string
  private chats = new Map<string, ChatSummary>()
  /** Deleted chats: nothing is written for them again. */
  private gone = new Set<string>()

  constructor(home = process.env.CORE_HOME ?? join(homedir(), '.agenthydra-core')) {
    this.home = home
    mkdirSync(join(home, 'chats'), { recursive: true })
    const file = join(home, 'chats.json')
    if (existsSync(file))
      for (const c of JSON.parse(readFileSync(file, 'utf8')) as ChatSummary[])
        this.chats.set(c.id, c)
  }

  list(): ChatSummary[] {
    return [...this.chats.values()]
  }

  /** Saves a chat's summary, new or changed: chats.json is rewritten whole, through a temp file. */
  put(chat: ChatSummary): void {
    if (this.gone.has(chat.id)) return
    this.chats.set(chat.id, chat)
    this.flush()
  }

  private flush(): void {
    const file = join(this.home, 'chats.json')
    writeFileSync(`${file}.tmp`, JSON.stringify([...this.chats.values()], null, 2))
    renameSync(`${file}.tmp`, file)
  }

  /** Appends one item (a new one, or the new version of an item already written). */
  append(id: string, item: TranscriptItem): void {
    if (this.gone.has(id)) return
    appendFileSync(this.file(id), `${JSON.stringify(item)}\n`)
  }

  /** The transcript, oldest first, each item as its last version. A torn last line (a crash mid-write) is skipped. */
  items(id: string): TranscriptItem[] {
    const file = this.file(id)
    if (!existsSync(file)) return []
    const byId = new Map<string, TranscriptItem>()
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const item = JSON.parse(line) as TranscriptItem
        byId.set(item.id, item)
      } catch {
        // A torn line: the item before it still stands.
      }
    }
    return [...byId.values()]
  }

  /** Takes one item out of the transcript (a queued message taken back): the file is rewritten without it. */
  drop(id: string, itemId: string): void {
    if (this.gone.has(id)) return
    const kept = this.items(id).filter((i) => i.id !== itemId)
    writeFileSync(this.file(id), kept.map((i) => `${JSON.stringify(i)}\n`).join(''))
  }

  /** Forgets a chat for good: its summary leaves chats.json and its transcript file is removed. */
  remove(id: string): void {
    this.gone.add(id)
    this.chats.delete(id)
    rmSync(this.file(id), { force: true })
    this.flush()
  }

  private file(id: string): string {
    return join(this.home, 'chats', `${id}.jsonl`)
  }
}
