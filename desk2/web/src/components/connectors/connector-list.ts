// The page's one shared read of GET /api/connectors (shared/connectors.ts): which connectors are on and on this machine,
// polled while anything on the page watches it.
import { ref } from 'vue'
import { CONNECTORS, type ConnectorsResponse, type ConnectorView } from '@shared/connectors'
import { cappedDelay } from './logic'

export const connectorList = ref<ConnectorView[] | null>(null)

let lastText = ''
let lastList: ConnectorView[] | null = null
let changedAt = Date.now()

export async function refreshConnectorList(): Promise<void> {
  try {
    const res = await fetch(CONNECTORS)
    if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) {
      // An unchanged answer (the common one, a poll a second while a connector starts) must not swap the list and redraw its watchers.
      const text = await res.text()
      if (text === lastText && connectorList.value && connectorList.value === lastList) return
      lastText = text
      changedAt = Date.now()
      connectorList.value = (JSON.parse(text) as ConnectorsResponse).connectors
      lastList = connectorList.value
    }
  } catch {
    /* the server is restarting: keep what was last seen */
  }
}

// One loop for every mounted watcher, at the fastest delay any of them asks for; it pauses while the window is hidden.
type Delay = () => number
const watchers = new Set<Delay>()
let timer: ReturnType<typeof setTimeout> | null = null

async function tick(): Promise<void> {
  timer = null
  if (!watchers.size) return
  timer = setTimeout(tick, cappedDelay(Math.min(...[...watchers].map((d) => d())), Date.now() - changedAt))
  if (!document.hidden) await refreshConnectorList()
}

/** Start watching the connector list; call the returned function to stop. The loop runs while at least one watcher is left. */
export function watchConnectors(delay: Delay): () => void {
  watchers.add(delay)
  if (!timer) void tick()
  return () => {
    watchers.delete(delay)
    if (!watchers.size && timer) {
      clearTimeout(timer)
      timer = null
    }
  }
}
