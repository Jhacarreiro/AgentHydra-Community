// Holds one Codex thread as its writer, as the Codex app would, until stdin closes (smoke.ts's codex-held-elsewhere):
//   bun core/smoke/codex-hold.ts <accountId> <threadId>
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connectCodexRpc } from '../../server/src/core/codex-rpc'

const [accountId, threadId] = process.argv.slice(2) as [string, string]
const rpc = await connectCodexRpc(join(homedir(), '.agenthydra', 'codex-instances', accountId), {
  timeoutMs: 120_000,
})
try {
  // A thread the server let go of a moment ago may still be loaded there: about 60 s when other chats keep its app-server up.
  for (const end = Date.now() + 80_000; ; await Bun.sleep(2000)) {
    try {
      await rpc.call('thread/resume', { threadId })
      break
    } catch (err) {
      if (Date.now() > end || !/active writer/i.test(err instanceof Error ? err.message : ''))
        throw err
    }
  }
  console.log('holding')
  await new Promise<void>((resolve) => {
    // The 5-minute cap must not keep the helper alive once stdin has let it go.
    const cap = setTimeout(resolve, 300_000)
    const done = () => {
      clearTimeout(cap)
      resolve()
    }
    process.stdin.on('end', done)
    process.stdin.on('close', done)
    process.stdin.resume()
  })
} catch (err) {
  console.log('hold failed', err instanceof Error ? err.message.slice(0, 160) : String(err))
} finally {
  await rpc.close()
}
