// A routine's `schedule`: a 5-field cron expression in LOCAL time (shared/routines.ts says which forms are taken). Pure:
// it parses, and finds the next slot after a time and the newest slot at or before one. Nothing here reads a clock.

export interface Cron {
  minutes: number[]
  hours: number[]
  months: Set<number>
  weekdays: Set<number>
  /** Day-of-month and day-of-week are both restricted: either matching counts. */
  eitherDay: boolean
  daysOfMonth: Set<number>
}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
] as const

/** How many days the search walks before it gives up: about 8 years covers every real expression (Feb 29 included). */
const MAX_DAYS = 366 * 8

/** One field's values, from `*`, `n`, `a-b`, `*\/n`, `a-b/n` and their comma lists. Throws with the reason. */
function parseField(text: string, name: string, min: number, max: number): Set<number> {
  const values = new Set<number>()
  const bad = (): Error => new Error(`${name} "${text}" must be a number, a range a-b, a list a,b, or a step */n or a-b/n`)
  for (const part of text.split(',')) {
    const m = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!m) throw bad()
    const [, star, a, b, step] = m
    if (star !== undefined && step === undefined) {
      for (let v = min; v <= max; v++) values.add(v)
      continue
    }
    const from = star !== undefined ? min : Number(a)
    const to = b !== undefined ? Number(b) : star !== undefined || step !== undefined ? max : from
    const by = step !== undefined ? Number(step) : 1
    if (by < 1 || from < min || to > max || from > to) throw bad()
    for (let v = from; v <= to; v += by) values.add(v)
  }
  return values
}

/** The expression, parsed. Throws with the reason it is not a cron expression this manager takes. */
export function parseCron(expr: string): Cron {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5 || expr.trim() === '') throw new Error('a schedule is 5 fields: minute hour day-of-month month day-of-week (no names, no @daily, no seconds)')
  const [minute, hour, dom, month, dow] = fields.map((text, i) => parseField(text, FIELDS[i].name, FIELDS[i].min, FIELDS[i].max))
  const weekdays = new Set([...dow].map((d) => (d === 7 ? 0 : d)))
  const domRestricted = fields[2] !== '*'
  const dowRestricted = fields[4] !== '*'
  return {
    minutes: [...minute].sort((a, b) => a - b),
    hours: [...hour].sort((a, b) => a - b),
    months: month,
    weekdays,
    eitherDay: domRestricted && dowRestricted,
    daysOfMonth: dom,
  }
}

/** Whether the local calendar day of `date` is one the expression runs on. */
function dayMatches(c: Cron, date: Date): boolean {
  if (!c.months.has(date.getMonth() + 1)) return false
  const byDom = c.daysOfMonth.has(date.getDate())
  const byDow = c.weekdays.has(date.getDay())
  return c.eitherDay ? byDom || byDow : byDom && byDow
}

/** The first slot strictly after `after` (ms), or null when none falls within the search. */
export function nextSlot(c: Cron, after: number): number | null {
  const start = Math.floor(after / 60_000) * 60_000 + 60_000
  let day = new Date(start)
  day.setHours(0, 0, 0, 0)
  for (let i = 0; i < MAX_DAYS; i++) {
    if (dayMatches(c, day)) {
      for (const h of c.hours) {
        for (const m of c.minutes) {
          const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime()
          if (at >= start) return at
        }
      }
    }
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  }
  return null
}

/** The newest slot at or before `at` (ms), or null when none falls within the search. */
export function previousSlot(c: Cron, at: number): number | null {
  const end = Math.floor(at / 60_000) * 60_000
  let day = new Date(end)
  day.setHours(0, 0, 0, 0)
  for (let i = 0; i < MAX_DAYS; i++) {
    if (dayMatches(c, day)) {
      for (let h = c.hours.length - 1; h >= 0; h--) {
        for (let m = c.minutes.length - 1; m >= 0; m--) {
          const slot = new Date(day.getFullYear(), day.getMonth(), day.getDate(), c.hours[h], c.minutes[m]).getTime()
          if (slot <= end) return slot
        }
      }
    }
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1)
  }
  return null
}
