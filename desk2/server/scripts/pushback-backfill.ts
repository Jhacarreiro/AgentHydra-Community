// Seeds <home>/pushback.json once from the transcripts of the chats a Desk data folder holds.
// Usage: bun scripts/pushback-backfill.ts <data folder>   (a second run adds nothing)
import { PushbackStore } from '../src/engine/pushback'
import { ChatStore } from '../src/engine/store'

const home = process.argv[2]
if (!home) {
  console.error('usage: bun scripts/pushback-backfill.ts <data folder>')
  process.exit(2)
}
const store = new ChatStore(home, {})
const pushback = new PushbackStore(home)
const AT_WORK = new Set(['starting', 'working', 'needs_you'])
const chats = store.loadChats().filter((c) => !c.service)
console.log(
  pushback.backfill(
    chats.map((c) => ({
      id: c.id,
      model: c.model,
      effort: c.effort,
      items: () => store.loadItems(c.id),
      ...(c.workerId !== undefined ? { worker: { busy: AT_WORK.has(c.status) } } : {}),
    })),
  ),
)
