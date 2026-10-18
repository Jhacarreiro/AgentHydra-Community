/**
 * 4MAN routes: GET /api/fourman (is it installed) and GET /api/fourman/board?cwd=|project=|all=1.
 */

import { isAbsolute } from 'node:path'
import { fourmanBoard, fourmanStatus } from '../fourman'
import { app } from '../http-app'

app.get('/api/fourman', async (c) => c.json(await fourmanStatus()))

app.get('/api/fourman/board', async (c) => {
  const cwd = c.req.query('cwd')?.trim()
  const project = c.req.query('project')?.trim()
  if (cwd) {
    if (!isAbsolute(cwd)) return c.json({ error: 'cwd must be an absolute folder' }, 400)
    return c.json(await fourmanBoard({ folder: cwd }))
  }
  if (project) return c.json(await fourmanBoard({ project }))
  if (c.req.query('all') === '1') return c.json(await fourmanBoard({ all: true }))
  return c.json({ error: 'pass cwd, project or all=1' }, 400)
})
