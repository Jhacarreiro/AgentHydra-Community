;(() => {
  const URL_JSON = '/_hydra/todo.json'
  const EVERY_MS = 30000
  const CAP = 8
  const TIERS = [
    ['A', 'Do first'],
    ['B', 'Schedule'],
    ['C', 'Delegate'],
    ['D', 'Later'],
  ]
  const CSS = `
[data-hydra-todo] { font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #e6e8ec; text-align: start; }
[data-hydra-todo] .ht-card { background: #1b1d22; border: 1px solid #2c2f36; border-radius: 8px; overflow: hidden; }
[data-hydra-todo] .ht-head { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px; border-bottom: 1px solid #2c2f36; }
[data-hydra-todo] .ht-proj { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
[data-hydra-todo] .ht-ready { margin-inline-start: auto; color: #8b909a; white-space: nowrap; }
[data-hydra-todo] .ht-sec { border-top: 1px solid #24272e; padding-bottom: 4px; }
[data-hydra-todo] .ht-sech { display: flex; align-items: baseline; gap: 6px; padding: 6px 10px 2px; font-size: 10px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: #9aa0aa; }
[data-hydra-todo] .ht-secc { margin-inline-start: auto; font: 400 10px ui-monospace, Consolas, monospace; color: #8b909a; }
[data-hydra-todo] .ht-row { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; min-width: 0; }
[data-hydra-todo] .ht-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-hydra-todo] .ht-tags { display: flex; gap: 4px; flex-shrink: 0; }
[data-hydra-todo] .ht-tag { font: 10px/14px ui-monospace, Consolas, monospace; color: #9aa0aa; border: 1px solid #2c2f36; border-radius: 4px; padding: 0 4px; }
[data-hydra-todo] .ht-live { color: #4ade80; border-color: #2f6b47; }
[data-hydra-todo] .ht-more { padding: 2px 10px 4px; font-size: 11px; color: #7aa2ff; }
`

  function el(tag, cls, text) {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (text != null) node.textContent = text
    return node
  }

  function byImpact(a, b) {
    return (b.impact || 0) - (a.impact || 0) || String(a.title).localeCompare(String(b.title))
  }

  function taskRow(task) {
    const row = el('div', 'ht-row')
    row.appendChild(el('span', 'ht-title', task.title || task.id))
    const tags = el('span', 'ht-tags')
    if (task.live) tags.appendChild(el('span', 'ht-tag ht-live', 'LIVE'))
    if (task.type) tags.appendChild(el('span', 'ht-tag', task.type))
    if (task.size) tags.appendChild(el('span', 'ht-tag', task.size))
    tags.appendChild(el('span', 'ht-tag', 'I:' + (task.impact || 0)))
    row.appendChild(tags)
    return row
  }

  function noteRow(note) {
    const row = el('div', 'ht-row')
    row.appendChild(el('span', 'ht-title', note.title || note.id))
    if (note.due) {
      const tags = el('span', 'ht-tags')
      tags.appendChild(el('span', 'ht-tag', note.due))
      row.appendChild(tags)
    }
    return row
  }

  function section(title, rows) {
    const node = el('section', 'ht-sec')
    const head = el('div', 'ht-sech')
    head.appendChild(el('span', null, title))
    head.appendChild(el('span', 'ht-secc', String(rows.length)))
    node.appendChild(head)
    for (const row of rows.slice(0, CAP)) node.appendChild(row)
    if (rows.length > CAP) node.appendChild(el('div', 'ht-more', `+${rows.length - CAP} more`))
    return node
  }

  function card(data) {
    const root = el('div', 'ht-card')
    const head = el('div', 'ht-head')
    head.appendChild(el('span', 'ht-proj', data.project || 'To-do'))
    head.appendChild(el('span', 'ht-ready', `${data.readyCount || 0} ready`))
    root.appendChild(head)

    const human = (data.human || []).slice().sort(byImpact)
    const notes = (data.notes || []).filter((n) => !n.done)
    const forYou = [...human.map(taskRow), ...notes.map(noteRow)]
    if (forYou.length) root.appendChild(section('For you', forYou))

    const humanIds = new Set(human.map((t) => t.id))
    const ready = (data.ready || []).filter((t) => !humanIds.has(t.id))
    for (const [tier, label] of TIERS) {
      const rows = ready.filter((t) => t.tier === tier).sort(byImpact)
      if (rows.length) root.appendChild(section(`${tier} · ${label}`, rows.map(taskRow)))
    }
    return root
  }

  function render(data) {
    for (const host of document.querySelectorAll('[data-hydra-todo]')) {
      host.textContent = ''
      if (data && data.available) host.appendChild(card(data))
    }
  }

  function load() {
    fetch(URL_JSON, { cache: 'no-store' })
      .then((r) => r.json())
      .then(render)
      .catch(() => render(null))
  }

  if (!document.getElementById('hydra-todo-style')) {
    const style = el('style', null, CSS)
    style.id = 'hydra-todo-style'
    document.head.appendChild(style)
  }
  load()
  setInterval(load, EVERY_MS)
})()
