// A scratch Hydra Core folder (AGENTHYDRA_CORE_DIR) with an invented catalog: two lead personas, one with a photo in
// a portraits folder beside its persona files, and one seat persona with none. Every name and path is invented.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The first bytes of a PNG: enough for a file served as a photo. */
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

export interface CoreFixture {
  dir: string
  /** The folder Ada's persona file is in; its ../portraits holds her photo. */
  seats: string
  portraits: string
  done(): void
}

export function coreFixture(opts: { on?: boolean; placement?: 'slot' | 'file' | 'attach' } = {}): CoreFixture {
  const saved = process.env.AGENTHYDRA_CORE_DIR
  const dir = mkdtempSync(join(tmpdir(), 'desk-core-'))
  process.env.AGENTHYDRA_CORE_DIR = dir
  const seats = join(dir, 'personas', 'seats')
  const portraits = join(dir, 'personas', 'portraits')
  mkdirSync(seats, { recursive: true })
  mkdirSync(portraits, { recursive: true })
  mkdirSync(join(dir, 'catalog'), { recursive: true })
  writeFileSync(join(seats, 'ada-layout.md'), 'Ada Example: invented brief for dashboard layouts.\n')
  writeFileSync(join(seats, 'bo-copy.md'), 'Bo Example: invented brief for copy.\n')
  writeFileSync(join(portraits, 'ada-layout.png'), PNG)
  const entries = [
    {
      id: 'person:ada-layout',
      kind: 'person',
      name: 'Ada Example',
      title: 'Layout designer',
      tier: 'employee',
      family: 'manager',
      when: 'Designs dashboard layouts and styling',
      tags: ['dashboard', 'layout'],
      modes: ['become', 'consult', 'hire'],
      cost: 'low',
      how: 'ask her to sketch the layout',
      load: { type: 'file', path: join(seats, 'ada-layout.md') },
    },
    {
      id: 'person:bo-copy',
      kind: 'person',
      name: 'Bo Example',
      title: 'Copy editor',
      tier: 'employee',
      family: 'manager',
      when: 'Edits release notes copy',
      tags: ['copy', 'notes'],
      modes: ['become', 'consult'],
      cost: 'low',
      how: 'hand him the draft',
      load: { type: 'file', path: join(seats, 'bo-copy.md') },
    },
  ]
  writeFileSync(join(dir, 'catalog', 'hand-desk-fixture.json'), JSON.stringify(entries))
  if (opts.on) writeFileSync(join(dir, 'ON'), '')
  if (opts.placement) writeFileSync(join(dir, 'PLACEMENT'), `${opts.placement}\n`)
  return {
    dir,
    seats,
    portraits,
    done() {
      if (saved === undefined) delete process.env.AGENTHYDRA_CORE_DIR
      else process.env.AGENTHYDRA_CORE_DIR = saved
      if (dir) rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Writes chats/<chat>/<name> under the fixture's core folder. */
export function writeChatFile(core: string, chat: string, name: string, text: string): void {
  mkdirSync(join(core, 'chats', chat), { recursive: true })
  writeFileSync(join(core, 'chats', chat, name), text)
}
