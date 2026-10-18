import { afterEach, describe, expect, test } from 'bun:test'
import { connectorList, refreshConnectorList } from '../../src/components/connectors/connections-api'
import { saveGlobals } from '../save-globals'

const restore = saveGlobals('fetch')
afterEach(restore)

const answer = (body: unknown) => async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

describe('refreshConnectorList', () => {
  test('an unchanged answer keeps the list the watchers draw; a changed one replaces it', async () => {
    globalThis.fetch = answer({ connectors: [{ id: 'a', state: 'starting' }] }) as unknown as typeof fetch
    await refreshConnectorList()
    const first = connectorList.value
    expect(first).toHaveLength(1)

    await refreshConnectorList()
    expect(connectorList.value).toBe(first)

    globalThis.fetch = answer({ connectors: [{ id: 'a', state: 'running' }] }) as unknown as typeof fetch
    await refreshConnectorList()
    expect(connectorList.value).not.toBe(first)
    expect(connectorList.value?.[0]?.state).toBe('running')
  })
})
