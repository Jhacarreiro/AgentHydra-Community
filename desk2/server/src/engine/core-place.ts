// Run by core-slot.ts as its own process: reads one placement ask as JSON on stdin, places the chat's pack with Hydra
// Core's placeChat, and prints {text} (or {error}) as the last line of stdout.
import { APPEND_MAX, pickForPlace, placeChat } from '../../../../server/src/hydra-core/placement'

try {
  const req = JSON.parse(await Bun.stdin.text()) as {
    dir: string
    chat: string
    session: string
    fresh: boolean
    cwd: string
    prompt: string
    placement: 'slot' | 'file'
    rest: number
  }
  // A first launch's lead pick is awaited here, before placeChat's synchronous build.
  const pick = await pickForPlace(req.dir, req)
  const placed = placeChat(req.dir, {
    chat: req.chat,
    session: req.session,
    fresh: req.fresh,
    cwd: req.cwd,
    prompt: req.prompt,
    placement: req.placement,
    room: APPEND_MAX - (req.rest + 2),
    pick,
  })
  process.stdout.write(`\n${JSON.stringify({ text: placed.text })}\n`)
} catch (err) {
  process.stdout.write(`\n${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n`)
}
