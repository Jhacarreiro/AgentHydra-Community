import { ref } from 'vue'

// The rows whose sub-chats are folded away with their fold button (owner, 2026-10-10: "I need the ability to collapse
// subthreads of a subagent"), by the row's key (logic.ts entryKey), remembered across reloads as the folded groups are.
const KEY = 'hydra-desk.sidebar.folded'
const storage = typeof localStorage === 'undefined' ? null : localStorage

function read(): string[] {
  try {
    const v = JSON.parse(storage?.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export const folded = ref<ReadonlySet<string>>(new Set(read()))

export function toggleFolded(key: string) {
  const next = new Set(folded.value)
  if (!next.delete(key)) next.add(key)
  folded.value = next
  storage?.setItem(KEY, JSON.stringify([...next]))
}
