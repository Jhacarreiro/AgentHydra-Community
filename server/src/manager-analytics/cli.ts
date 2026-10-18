import { runPass } from './collect'

const args = process.argv.slice(2)
if (!args.includes('--dry')) {
  console.error('usage: bun server/src/manager-analytics/cli.ts --dry [--days N|all]')
  process.exit(2)
}
const at = args.indexOf('--days')
const raw = at >= 0 ? args[at + 1] : undefined
const days = raw === undefined ? 7 : raw === 'all' ? 'all' : Number(raw)
if (days !== 'all' && !(Number.isFinite(days) && days > 0)) {
  console.error(`--days must be a positive number or "all", got "${raw}"`)
  process.exit(2)
}

const report = await runPass({ dry: true, days })
console.log(JSON.stringify(report.summary, null, 2))
