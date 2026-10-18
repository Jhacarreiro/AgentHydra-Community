<script setup lang="ts">
// The Jobs page: one list of HSwarm jobs, CliMayte workers and CliMayte waves, newest first, each row one
// line in CliMayte's row style with a kind badge (owner, 2026-10-10: one Jobs list, told apart by kind). A
// HSwarm job opens right under its row (owner, 2026-10-04: "The HSwarm jobs should expand in place on the
// table to show the data instead of making it appear on the bottom."); a CliMayte row opens on its own page.
// One job is open at a time; a second click, its close button or Escape closes it.
//
// An open job is short (owner, 2026-10-05: the page "is, like, way too verbose ... it doesn't, like,
// collapse or scroll"): one line of summary (label, state, counts, cost, time, the chat that called
// it), then its task results, one line per task, folded past FOLD_AT tasks and scrolling in a box of
// their own. A task's line opens its whole answer in a box that scrolls too; what the list is for is
// behind the info icon on its heading.
import {
  AlertCircle,
  Ban,
  CircleCheck,
  CircleX,
  Clock,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  X,
} from '@lucide/vue'
import type { Component } from 'vue'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import CliMayteRow from '@/components/CliMayteRow.vue'
import CliMayteStatusBadge from '@/components/CliMayteStatusBadge.vue'
import { pii } from '@/composables/usePrivacy'
import { useCliMayteData } from '@/composables/useCliMayteData'
import type { ChatListResult, CliMayteWave, CliMayteWaveStatus, CliMayteWorkerView } from '@/lib/api'
import { j as getJson } from '@/lib/api'
import { activeSeconds, activeTime, openWaveRow, runTag } from '@/lib/climayte-rows'
import { firstLine, isCliMayteActive } from '@/lib/climayte-status'
import { EMBEDDED, openInDesk } from '@/lib/desk-embed'
import type { HswarmState } from '@/lib/hswarm-api'
import { useHswarmApi } from '@/lib/hswarm-api'
import { missingQueued } from '@/lib/job-tasks'
import { jobOfRoutine, workerOfRoutine } from '@/lib/managers'
import { formatTokens, formatUsd } from '@/lib/kit'
import InfoHint from '@/shell/InfoHint.vue'

const { t } = useI18n()
const { apiCall } = useHswarmApi()

// jobId: set when the HSwarm tree picked one job; the page opens with that job open under its row.
// routine: set on a routine's page (Managers): only the work it started (its CliMayte workers and its HSwarm jobs, lib/managers.ts).
const props = defineProps<{ state: HswarmState; jobId?: string; routine?: string }>()
// open-task: a CliMayte worker (wave false) or a wave (wave true) was clicked; HSwarmView opens it on its page.
const emit = defineEmits<{ changed: []; 'open-task': [id: string, wave: boolean] }>()

interface CallerStamp {
  session_id?: string | null
  chat_id?: string | null
  instance?: string | null
}

interface Job {
  job_id: string
  label: string
  state: string
  tasks: number
  counts: Record<string, number>
  cost_usd: number
  tokens?: number
  created: string
  /** When it ended; '' (or nothing) while it runs. */
  finished?: string | boolean | null
  /** hswarm/caller.py key(): '<instance> / <8 chars of the session> / <folder>'. */
  caller?: string | CallerStamp | null
  /** The caller's full ids: a Claude Desktop chat has an empty session_id and a chat_id ('local_...'). */
  caller_ids?: CallerStamp | null
}

interface TaskResult {
  id: string
  status: string
  model?: string
  /** Missing when its cost is not known; 0 is free. */
  cost_usd?: number | null
  answer?: string
  error?: string
  data?: unknown
}

interface JobDetail {
  /** The job's status (no created, finished or caller: those are its row's), or { error } for a job HSwarm lost. */
  status?: Partial<Job> & { error?: string }
  results?: {
    /** The finished tasks, in task order (a record read from disk lists its unfinished ones here too). */
    results?: TaskResult[]
    /** A live job's running tasks, with how long each has run. */
    running?: Array<{ id: string; elapsed_s?: number }>
    error?: string
  }
  error?: string
}

// The one list's rows are HSwarm jobs (here), CliMayte workers and CliMayte waves (the composable's, which
// CliMayte's own page and warm-data read too: nothing is fetched twice).
type Where = 'all'
type Kind = 'hswarm' | 'climayte' | 'wave'
const KINDS: Kind[] = ['hswarm', 'climayte', 'wave']
const KIND_FILTER_KEY: Record<Kind, string> = { hswarm: 'hswarm', climayte: 'climayte', wave: 'waves' }
const STATUS_FILTERS = ['all', 'running'] as const
const DOT_CLASS = {
  run: 'bg-primary animate-pulse',
  ok: 'bg-success',
  bad: 'bg-destructive',
  off: 'bg-muted-foreground/50',
}
/** Rows shown at a time; "Show more" adds this many. */
const PAGE = 50

const { workers, waves, listedAt, hasOlder, showOlder: widenFinished, refreshCliMayte } = useCliMayteData()
const statusFilter = ref<(typeof STATUS_FILTERS)[number]>('all')
/** The kinds picked; none picked shows every kind. */
const kindFilter = ref<Kind[]>([])
const limit = ref(PAGE)
// The elapsed times count with this clock: a tick every 15 seconds (the list is read, not polled).
const now = ref(Date.now())

interface Item {
  key: string
  kind: Kind
  /** When it was made, in ms. */
  at: number
  running: boolean
  job?: Job
  worker?: CliMayteWorkerView
  wave?: CliMayteWave
}

// Newest first, all three kinds together.
const items = computed<Item[]>(() =>
  [
    ...jobs.value.map(
      (job): Item => ({
        key: `hswarm:${job.job_id}`,
        kind: 'hswarm',
        at: Date.parse(job.created) || 0,
        running: jobDot(job.state) === 'run',
        job,
      }),
    ),
    ...workers.value.map(
      (worker): Item => ({
        key: `climayte:${worker.id}`,
        kind: 'climayte',
        at: worker.createdAt,
        running: isCliMayteActive(worker),
        worker,
      }),
    ),
    ...waves.value.map(
      (wave): Item => ({
        key: `wave:${wave.id}`,
        kind: 'wave',
        at: wave.createdAt,
        running: wave.status === 'running' || wave.status === 'reported',
        wave,
      }),
    ),
  ]
    .filter(
      (it) =>
        !props.routine ||
        (it.job ? jobOfRoutine(it.job.label, props.routine) : it.worker ? workerOfRoutine(it.worker.group, props.routine) : false),
    )
    .sort((a, b) => b.at - a.at),
)

const matching = computed(() =>
  items.value.filter(
    (it) =>
      (statusFilter.value === 'all' || it.running) &&
      (!kindFilter.value.length || kindFilter.value.includes(it.kind)),
  ),
)

function toggleKind(k: Kind) {
  kindFilter.value = kindFilter.value.includes(k)
    ? kindFilter.value.filter((x) => x !== k)
    : [...kindFilter.value, k]
}

/** What a row shows: the one line's texts, worked out for the rows on screen. */
interface Row {
  item: Item
  jobId: string | null
  running: boolean
  title: string
  kind: string
  account: string
  time: string
  tag: { text: string; differs: boolean } | null
  hint: string
  priority?: number
  dot: 'run' | 'ok' | 'bad' | 'off'
}

function waveDot(status: CliMayteWaveStatus): Row['dot'] {
  if (status === 'running' || status === 'reported') return 'run'
  if (status === 'verified') return 'ok'
  if (status === 'failed' || status === 'rejected') return 'bad'
  return 'off'
}

/** The instance that called a job, masked in privacy mode; '' when the job has none. */
function callerOf(job: Job): string {
  const name =
    job.caller_ids?.instance ??
    (typeof job.caller === 'string' ? job.caller.split(' / ')[0] : job.caller?.instance)
  return name ? pii(name) : ''
}

function elapsed(from: number, to: number): string {
  return to > from ? spanText((to - from) / 1000) : '–'
}

function rowOf(it: Item): Row {
  const kind = t(`hswarm.v.jobs.kind.${it.kind}`)
  if (it.job) {
    const job = it.job
    const finished = typeof job.finished === 'string' && job.finished ? Date.parse(job.finished) : NaN
    return {
      item: it,
      jobId: job.job_id,
      running: it.running,
      title: job.label || job.job_id.substring(0, 8),
      kind,
      account: callerOf(job),
      time: elapsed(it.at, it.running ? now.value : finished || it.at),
      tag: { text: `${tallyText(job.counts)} · ${costText(job.cost_usd)}`, differs: false },
      hint: [job.label || job.job_id, kind, tallyText(job.counts)].join('\n'),
      dot: jobDot(job.state),
    }
  }
  if (it.worker) {
    const w = it.worker
    const p = activeTime(activeSeconds(w, now.value, listedAt.value))
    const account = w.account ? pii(w.account) : t('climayte.noAccount')
    return {
      item: it,
      jobId: null,
      running: it.running,
      title: w.title,
      kind,
      account,
      time: t(p.key, p.values),
      tag: runTag(w),
      hint: [w.title, kind, account].join('\n'),
      priority: w.priority,
      dot: 'off',
    }
  }
  const wv = it.wave!
  return {
    item: it,
    jobId: null,
    running: it.running,
    title: firstLine(wv.plan) || wv.id,
    kind,
    account: '',
    time: elapsed(it.at, it.running ? now.value : wv.updatedAt),
    tag: { text: t('hswarm.v.jobs.waveTasks', { n: wv.tasks.length }), differs: false },
    hint: [firstLine(wv.plan) || wv.id, kind].join('\n'),
    dot: waveDot(wv.status),
  }
}

const rows = computed<Row[]>(() => matching.value.slice(0, limit.value).map(rowOf))

/** A row click: a HSwarm job opens its detail here; a CliMayte worker or wave opens on its own page. */
function pick(it: Item) {
  if (it.job) toggleJob(it.job.job_id, 'all')
  else if (it.worker) emit('open-task', it.worker.id, false)
  else if (it.wave) {
    openWaveRow(it.wave.id)
    emit('open-task', it.wave.id, true)
  }
}

function cancelRowJob(r: Row) {
  if (r.jobId) void cancelJob(r.jobId)
}

/** Finished CliMayte tasks older than the ones read: widen the read and read again. */
function showOlder() {
  widenFinished()
  void refreshCliMayte()
}

const jobs = ref<Job[]>([])
const selectedJobId = ref<string | null>(null)
const jobDetail = shallowRef<JobDetail | null>(null)
const isLoading = ref(true)
const isLoadingDetail = ref(false)
const error = ref<string | null>(null)
const isCancelling = ref(false)
const detailError = ref<string | null>(null)
const rootEl = ref<HTMLElement | null>(null)

// The open job's detail is drawn under its row. A reload never closes it: the job stays listed while the
// list refreshes, and its detail is read again quietly.
const detailIn = computed<Where | null>(() => {
  const id = selectedJobId.value
  if (!id) return null
  return jobs.value.some((job) => job.job_id === id) ? 'all' : null
})

const isOpen = (where: Where, jobId: string) =>
  selectedJobId.value === jobId && detailIn.value === where
const detailId = (where: Where, jobId: string) => `hs-job-${where}-${encodeURIComponent(jobId)}`
const toggleEl = (where: Where, jobId: string) =>
  rootEl.value?.querySelector<HTMLElement>(`[data-job-toggle="${CSS.escape(`${where}:${jobId}`)}"]`)

function jobDot(state: string): 'run' | 'ok' | 'bad' | 'off' {
  if (state === 'running' || state === 'queued') return 'run'
  if (state === 'done' || state === 'finished') return 'ok'
  if (/fail|error/i.test(state)) return 'bad'
  return 'off'
}

function stateVariant(state: string): 'info' | 'success' | 'destructive' | 'muted' {
  switch (jobDot(state)) {
    case 'run':
      return 'info'
    case 'ok':
      return 'success'
    case 'bad':
      return 'destructive'
    default:
      return 'muted'
  }
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '–'
  try {
    const date = new Date(dateStr)
    return date.toLocaleString()
  } catch {
    return dateStr
  }
}

const costText = (cost: number | null | undefined) => formatUsd(cost, { style: 'fine' })

/** "4m", "2h 5m": how long something ran. */
function spanText(totalS: number): string {
  const m = Math.floor(totalS / 60)
  if (m < 1) return t('hswarm.v.jobs.spanSeconds', { s: Math.max(0, Math.floor(totalS)) })
  if (m < 60) return t('hswarm.v.jobs.spanMinutes', { m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('hswarm.v.jobs.spanHours', { h, m: m % 60 })
  return t('hswarm.v.jobs.spanDays', { d: Math.floor(h / 24), h: h % 24 })
}

// --- task counts ----------------------------------------------------------------------------------
// HSwarm counts tasks by their own status (ok, error, timeout, loop, cancelled, pending, running); the
// page says done, failed, running, queued and cancelled.
interface Tally {
  done: number
  failed: number
  running: number
  queued: number
  cancelled: number
}
const NOT_FAILED = new Set(['ok', 'running', 'pending', 'cancelled'])
const isFailed = (status: string) => !NOT_FAILED.has(status)

function tally(counts?: Record<string, number>): Tally {
  const out: Tally = { done: 0, failed: 0, running: 0, queued: 0, cancelled: 0 }
  for (const [status, n] of Object.entries(counts ?? {})) {
    if (status === 'ok') out.done += n
    else if (status === 'running') out.running += n
    else if (status === 'pending') out.queued += n
    else if (status === 'cancelled') out.cancelled += n
    else out.failed += n
  }
  return out
}

const TALLY_KEY: Record<keyof Tally, string> = {
  done: 'hswarm.v.jobs.countDone',
  failed: 'hswarm.v.jobs.countFailed',
  running: 'hswarm.v.jobs.countRunning',
  queued: 'hswarm.v.jobs.countQueued',
  cancelled: 'hswarm.v.jobs.countCancelled',
}
const TALLY_TONE: Record<keyof Tally, string> = {
  done: 'text-success',
  failed: 'text-destructive',
  running: 'text-info',
  queued: 'text-muted-foreground',
  cancelled: 'text-muted-foreground',
}
// Always said, a zero included: the three the summary is read for.
const ALWAYS = new Set<keyof Tally>(['done', 'failed', 'running'])

/** "12 done · 1 failed": the counts that are not zero, '–' when there are none. */
function tallyText(counts?: Record<string, number>): string {
  const c = tally(counts)
  const parts = (Object.keys(c) as Array<keyof Tally>)
    .filter((k) => c[k] > 0)
    .map((k) => t(TALLY_KEY[k], { n: c[k] }))
  return parts.length ? parts.join(' · ') : '–'
}

/** The summary's counts, each in its own colour: done, failed and running always, the rest when there are some. */
function countParts(counts?: Record<string, number>) {
  const c = tally(counts)
  return (Object.keys(c) as Array<keyof Tally>)
    .filter((k) => c[k] > 0 || ALWAYS.has(k))
    .map((k) => ({ key: k, text: t(TALLY_KEY[k], { n: c[k] }), tone: c[k] > 0 ? TALLY_TONE[k] : 'text-muted-foreground' }))
}

async function loadJobs() {
  isLoading.value = true
  error.value = null
  try {
    const response = await apiCall('jobs', { method: 'GET' })
    jobs.value = response.jobs || []
  } catch (err) {
    // The last list stays on screen under the error: a failed reload does not close the open job.
    error.value = err instanceof Error ? err.message : t('hswarm.v.jobs.failedToLoad')
    toast.error(t('hswarm.v.jobs.failedToLoad'))
  } finally {
    isLoading.value = false
  }
}

// --- the open job ---------------------------------------------------------------------------------

// The open job's own row in the list: its created, finished and caller (the list is HSwarm's verbose read).
const openRow = computed(() => jobs.value.find((job) => job.job_id === selectedJobId.value))

/** "took 4m" for a finished job, "running for 4m" for a running one; its dates on hover. */
function jobTime(job: Job | undefined): { time: string; timeHint: string } {
  const created = job?.created ?? ''
  const start = created ? Date.parse(created) : Number.NaN
  if (!job || !Number.isFinite(start)) return { time: '–', timeHint: '' }
  const finished = typeof job.finished === 'string' ? job.finished : ''
  const end = finished ? Date.parse(finished) : Number.NaN
  if (Number.isFinite(end)) {
    return {
      time: t('hswarm.v.jobs.tookTime', { span: spanText((end - start) / 1000) }),
      timeHint: t('hswarm.v.jobs.timeHintFinished', { created: formatDate(created), finished: formatDate(finished) }),
    }
  }
  const timeHint = t('hswarm.v.jobs.timeHint', { created: formatDate(created) })
  if (jobDot(job.state) === 'run') {
    return { time: t('hswarm.v.jobs.runningTime', { span: spanText((Date.now() - start) / 1000) }), timeHint }
  }
  return { time: formatDate(created), timeHint }
}

// The open job's one-line summary: the detail's fresh status where it has one, else the job's row.
const summary = computed(() => {
  const row = openRow.value
  const s = jobDetail.value?.status
  // A job HSwarm could not read answers only { error }; a job-wide error rides beside a real status.
  const live = s?.job_id ? s : undefined
  const tokens = live?.tokens ?? row?.tokens
  return {
    label: live?.label || row?.label || '',
    state: live?.state ?? row?.state ?? '',
    counts: countParts(live?.counts ?? row?.counts),
    total: row?.tasks,
    cost: costText(live?.cost_usd ?? row?.cost_usd),
    costHint:
      tokens == null
        ? t('hswarm.v.money.atListPrice')
        : t('hswarm.v.jobs.costHint', { tokens: formatTokens(tokens) }),
    ...jobTime(row),
    // The one job-wide reason its tasks failed (no credit left), or why HSwarm could not read the job.
    error: s?.error ?? '',
  }
})

// --- the chat that called it ----------------------------------------------------------------------

/** The caller's ids from the job's stamp; an older answer has only the key's 8-character session prefix. */
function callerIdsOf(job: Job | undefined): { sessionId: string; chatId: string } | null {
  if (!job) return null
  const ids = job.caller_ids ?? (job.caller && typeof job.caller === 'object' ? job.caller : null)
  if (ids) {
    const sessionId = ids.session_id || ''
    const chatId = ids.chat_id || ''
    return sessionId || chatId ? { sessionId, chatId } : null
  }
  const part = typeof job.caller === 'string' ? (job.caller.split(' / ')[1]?.trim() ?? '') : ''
  return part && part !== '-' ? { sessionId: part, chatId: '' } : null
}

// Chat titles by the id they were asked for, from AgentHydra's chat list (archived chats too: a finished
// job's chat often is by now). Each chat is asked once while the page is up; one it does not know (a chat
// run outside Claude Desktop) stays unnamed.
const chatNames = reactive(new Map<string, { sessionId: string; title: string | null }>())
const chatAsked = new Set<string>()

// A whole id only, which no other chat holds: a prefix could match two chats, and a caller is never a guess.
const callerQuery = computed(() => {
  const ids = callerIdsOf(openRow.value)
  if (ids?.chatId) return ids.chatId
  return ids && ids.sessionId.length > 8 ? ids.sessionId : ''
})

watch(
  callerQuery,
  (q) => {
    if (!q || chatAsked.has(q)) return
    chatAsked.add(q)
    void getJson<ChatListResult>(`/api/chats?q=${encodeURIComponent(q)}&archived=include&limit=1`).then(
      (res) => {
        const row = res.rows?.[0]
        if (row) chatNames.set(q, { sessionId: row.sessionId ?? '', title: row.title ?? null })
      },
      // Asked again the next time the job opens.
      () => chatAsked.delete(q),
    )
  },
  { immediate: true },
)

const caller = computed(() => {
  const ids = callerIdsOf(openRow.value)
  if (!ids) return null
  const named = chatNames.get(callerQuery.value)
  const sessionId = named?.sessionId || ids.sessionId
  const short = (ids.chatId || ids.sessionId).replace(/^local_/, '').slice(0, 8)
  return {
    name: named?.title ? pii(named.title) : t('hswarm.v.jobs.callerUnnamed', { id: short }),
    // Desk opens a chat by its whole CLI session id; the old key's prefix is not one.
    open: EMBEDDED && sessionId.length > 8 ? sessionId : '',
  }
})

function openCaller() {
  const id = caller.value?.open
  if (id) openInDesk({ session_id: id, source: 'claude' })
}

// --- the task results -----------------------------------------------------------------------------

// Past this many tasks the list opens folded to its heading; it is decided once per opened job, so a
// running job that grows past it does not fold under the person reading it.
const FOLD_AT = 5
// Lines drawn at a time: a job can hold thousands of tasks.
const TASK_PAGE = 150

interface TaskMark {
  icon: Component
  tone: string
  spin?: boolean
  label: string
}

interface TaskRow {
  id: string
  status: string
  model: string
  cost: number | null | undefined
  mark: TaskMark
  /** The first line of what it said (a failed task's error first), for its one line. */
  first: string
  firstTone: string
  /** Everything it said, for the box its line opens. */
  full: string
}

function taskMark(status: string): TaskMark {
  if (status === 'ok') return { icon: CircleCheck, tone: 'text-success', label: t('hswarm.v.jobs.markDone') }
  if (status === 'running')
    return { icon: LoaderCircle, tone: 'text-info', spin: true, label: t('hswarm.v.jobs.markRunning') }
  if (status === 'pending') return { icon: Clock, tone: 'text-muted-foreground', label: t('hswarm.v.jobs.markQueued') }
  if (status === 'cancelled')
    return { icon: Ban, tone: 'text-muted-foreground', label: t('hswarm.v.jobs.markCancelled') }
  return { icon: CircleX, tone: 'text-destructive', label: t('hswarm.v.jobs.markFailed', { status }) }
}

const headLine = (text: string) => (text.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 300)

function resultRow(r: TaskResult): TaskRow {
  const failed = isFailed(r.status)
  // With a schema the answer is `data` (HSwarm drops an `answer` that only repeats it).
  const hasData = r.data !== undefined && r.data !== null
  const dataLine = !hasData ? '' : typeof r.data === 'string' ? r.data : JSON.stringify(r.data)
  const dataFull = !hasData ? '' : typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2)
  const head = failed && r.error ? r.error : r.answer || dataLine || r.error || ''
  const full = [failed ? r.error : '', r.answer, dataFull, failed ? '' : r.error].filter(Boolean).join('\n\n')
  return {
    id: r.id,
    status: r.status,
    model: r.model ?? '',
    cost: r.cost_usd,
    mark: taskMark(r.status),
    first: headLine(head),
    firstTone: failed ? 'text-destructive' : '',
    full: full || t('hswarm.v.jobs.noAnswer'),
  }
}

// The running tasks first (what is happening now), then the finished ones in task order.
const taskRows = computed<TaskRow[]>(() => {
  const r = jobDetail.value?.results
  if (!r) return []
  const running = (r.running ?? []).map(
    (x): TaskRow => ({
      id: x.id,
      status: 'running',
      model: '',
      cost: undefined,
      mark: taskMark('running'),
      first: t('hswarm.v.jobs.runningTime', { span: spanText(x.elapsed_s ?? 0) }),
      firstTone: 'text-muted-foreground',
      full: t('hswarm.v.jobs.noAnswerYet'),
    }),
  )
  const finished = (r.results ?? []).map(resultRow)
  // Queued tasks have no id or answer yet, so HSwarm lists none: a muted line each, last, so the lines
  // add up to the summary's counts (the same counts it reads).
  const s = jobDetail.value?.status
  const counts = (s?.job_id ? s.counts : undefined) ?? openRow.value?.counts
  const queued = Array.from(
    { length: missingQueued(counts, [...running, ...finished]) },
    (_, i): TaskRow => ({
      id: `queued-${i + 1}`,
      status: 'pending',
      model: '',
      cost: undefined,
      mark: taskMark('pending'),
      first: t('hswarm.v.jobs.markQueued'),
      firstTone: 'text-muted-foreground',
      full: t('hswarm.v.jobs.noAnswerQueued'),
    }),
  )
  return [...running, ...finished, ...queued]
})

const taskCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const row of taskRows.value) counts[row.status] = (counts[row.status] ?? 0) + 1
  return counts
})

const resultsError = computed(() => jobDetail.value?.results?.error ?? '')
const resultsOpen = ref(true)
const taskLimit = ref(TASK_PAGE)
const shownTasks = computed(() => taskRows.value.slice(0, taskLimit.value))
// One task's answer open at a time.
const openTask = ref<string | null>(null)
// The job the fold was decided for: a reload of the same job keeps the person's choice.
let foldedFor: string | null = null

function toggleTask(id: string) {
  openTask.value = openTask.value === id ? null : id
}

// Bumped by every detail fetch: an answer that lands after a newer fetch began (another job was
// opened meanwhile) is dropped instead of filling the newer job's row.
let detailSeq = 0

// quiet: a reload's refetch, which keeps the open detail on screen until the new one arrives.
async function loadJobDetail(jobId: string, quiet = false) {
  const seq = ++detailSeq
  if (!quiet) {
    isLoadingDetail.value = true
    detailError.value = null
  }
  try {
    const response = await apiCall(`job?id=${encodeURIComponent(jobId)}`, {
      method: 'GET',
    })
    if (seq !== detailSeq) return
    jobDetail.value = response
    detailError.value = null
    if (foldedFor !== jobId) {
      foldedFor = jobId
      resultsOpen.value = taskRows.value.length <= FOLD_AT
      taskLimit.value = TASK_PAGE
      openTask.value = null
    }
  } catch (err) {
    if (seq !== detailSeq) return
    detailError.value = err instanceof Error ? err.message : t('hswarm.v.jobs.jobNotFound')
    jobDetail.value = null
  } finally {
    if (seq === detailSeq) isLoadingDetail.value = false
  }
}

// Opens a job under its row in one table; the same job open in the other table just moves there.
async function openJob(jobId: string, where: Where) {
  if (selectedJobId.value === jobId) return
  selectedJobId.value = jobId
  await loadJobDetail(jobId)
  // A row near the bottom opens below the fold: once the summary is in and has grown open (150 ms), bring
  // it into view, the least scroll that shows it (owner, 2026-10-04: "I don't wanna scroll ... to see that").
  await nextTick()
  setTimeout(() => {
    if (selectedJobId.value !== jobId) return
    document.getElementById(detailId(where, jobId))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, 170)
}

function closeJob() {
  const where = detailIn.value
  const id = selectedJobId.value
  // Focus inside the closing detail (its close button) would fall to the page: back to the row.
  const detail = where && id ? document.getElementById(detailId(where, id)) : null
  if (where && id && detail?.contains(document.activeElement)) toggleEl(where, id)?.focus()
  selectedJobId.value = null
  // Opened again, it starts as a fresh open: folded by its size, no answer open.
  foldedFor = null
}

function toggleJob(jobId: string, where: Where) {
  if (isOpen(where, jobId)) closeJob()
  else void openJob(jobId, where)
}

// A reload keeps the open job open: the tables stay on screen while the list refreshes, and the
// open job's detail is fetched again quietly, so its row neither collapses nor jumps.
async function reload() {
  const open = selectedJobId.value
  await Promise.all([loadJobs(), open ? loadJobDetail(open, true) : null])
}

async function cancelJob(jobId: string) {
  if (isCancelling.value || !confirm(t('hswarm.v.jobs.confirmCancel', { id: jobId }))) {
    return
  }

  isCancelling.value = true
  try {
    const response = await apiCall('job/cancel', {
      method: 'POST',
      body: JSON.stringify({ id: jobId }),
    })
    if (response?.error) {
      throw new Error(response.error)
    }
    toast.success(t('hswarm.v.jobs.jobCancelled'))
    await reload()
    emit('changed')
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : t('hswarm.v.jobs.failedToLoad')
    toast.error(errorMsg)
  } finally {
    isCancelling.value = false
  }
}

// Escape closes the open job while the focus is on this page or on nothing at all (a click on a
// row's text leaves it on the body, not in the table); a key meant for the tree or for a field
// elsewhere is left alone.
function onWindowKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented || !detailIn.value) return
  const el = e.target as HTMLElement | null
  const here =
    !el || el === document.body || el === document.documentElement || !!rootEl.value?.contains(el)
  if (!here || el?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? '')) return
  e.preventDefault()
  closeJob()
}

let clock: ReturnType<typeof setInterval> | undefined
onMounted(async () => {
  window.addEventListener('keydown', onWindowKey)
  clock = setInterval(() => (now.value = Date.now()), 15_000)
  const listed = loadJobs()
  if (!props.jobId) return
  // A job picked in the tree opens in the list, and its row is scrolled to the top once the list and its
  // detail have loaded.
  const id = props.jobId
  await Promise.all([listed, openJob(id, 'all')])
  await nextTick()
  const where = detailIn.value
  if (where) toggleEl(where, id)?.closest('li')?.scrollIntoView({ block: 'start' })
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKey)
  clearInterval(clock)
})
</script>

<template>
  <div ref="rootEl" class="flex h-full flex-col gap-2 p-4">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold">
        {{ t('hswarm.v.jobs.title') }}
      </h2>
      <Button size="sm" variant="outline" :disabled="isLoading" @click="reload">
        <RefreshCw :class="{ 'animate-spin': isLoading }" class="size-4" />
        <span class="hidden sm:inline ms-1">{{ t('hswarm.v.jobs.reload') }}</span>
      </Button>
    </div>

    <!-- Error Alert -->
    <Alert v-if="error" variant="destructive">
      <AlertCircle class="size-4" />
      <AlertTitle>{{ t('hswarm.v.jobs.failedToLoad') }}</AlertTitle>
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <!-- Loading State (first load only: a reload keeps the tables, and the open job, in place) -->
    <div v-if="isLoading && !jobs.length" class="space-y-2">
      <Skeleton class="h-10 w-full" />
      <Skeleton class="h-10 w-full" />
      <Skeleton class="h-10 w-full" />
    </div>

    <!-- Empty State -->
    <div
      v-else-if="!items.length"
      class="flex flex-col items-center justify-center gap-3 py-4 text-center"
    >
      <div class="text-4xl text-muted-foreground">✨</div>
      <div>
        <h3 class="font-semibold">{{ t('hswarm.v.jobs.noJobs') }}</h3>
        <p class="text-sm text-muted-foreground">
          {{ t('hswarm.v.jobs.noJobsDescription') }}
        </p>
      </div>
    </div>

    <!-- Main Content: HSwarm jobs, CliMayte workers and waves in one list, newest first -->
    <div v-else class="flex flex-col gap-2 overflow-auto flex-1">
      <!-- The filters: running or all, then the kinds (none picked means every kind) -->
      <div class="flex flex-wrap items-center gap-1.5" role="group" :aria-label="t('hswarm.v.jobs.filter.label')">
        <Button
          v-for="f in STATUS_FILTERS"
          :key="f"
          size="sm"
          :variant="statusFilter === f ? 'secondary' : 'ghost'"
          :aria-pressed="statusFilter === f"
          @click="statusFilter = f"
        >
          {{ t(`hswarm.v.jobs.filter.${f}`) }}
        </Button>
        <span class="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        <Button
          v-for="k in KINDS"
          :key="k"
          size="sm"
          :variant="kindFilter.includes(k) ? 'secondary' : 'ghost'"
          :aria-pressed="kindFilter.includes(k)"
          @click="toggleKind(k)"
        >
          {{ t(`hswarm.v.jobs.filter.${KIND_FILTER_KEY[k]}`) }}
        </Button>
      </div>

      <ul
        v-if="matching.length"
        class="flex flex-col rounded-lg border bg-card py-0.5"
        :aria-label="t('hswarm.v.jobs.title')"
      >
        <!-- One line per row (CliMayteRow, as the CliMayte list). A HSwarm job opens its detail right under it. -->
        <li v-for="r in rows" :key="r.item.key">
          <div class="group/row relative">
            <CliMayteRow
              :title="r.title"
              :kind="r.kind"
              :account="r.account"
              :time="r.time"
              :tag="r.tag"
              :hint="r.hint"
              :priority="r.priority"
              :data-job-toggle="r.jobId ? `all:${r.jobId}` : undefined"
              :aria-expanded="r.jobId ? isOpen('all', r.jobId) : undefined"
              :aria-controls="r.jobId && isOpen('all', r.jobId) ? detailId('all', r.jobId) : undefined"
              @click="pick(r.item)"
            >
              <CliMayteStatusBadge
                v-if="r.item.worker"
                :status="r.item.worker.status"
                :hold="r.item.worker.hold"
                icon-only
                :task="r.item.worker"
                :tasks="workers"
              />
              <span v-else class="inline-flex size-4 shrink-0 items-center justify-center">
                <span class="size-2 rounded-full" :class="DOT_CLASS[r.dot]" />
              </span>
            </CliMayteRow>
            <!-- A running HSwarm job can be cancelled from its row; it shows on hover, as a CliMayte row's forget does -->
            <Button
              v-if="r.jobId && r.running"
              variant="row-reveal"
              size="icon-xs"
              class="absolute end-1.5 top-1/2 -translate-y-1/2"
              :aria-label="t('hswarm.v.jobs.cancelJob')"
              :title="t('hswarm.v.jobs.cancelJob')"
              :disabled="isCancelling"
              @click="cancelRowJob(r)"
            >
              <X />
            </Button>
          </div>

          <!-- The open job, right under its row: a one-line summary, then its task results -->
          <div
            v-if="r.jobId && isOpen('all', r.jobId)"
            :id="detailId('all', r.jobId)"
            class="border-b bg-muted/30"
          >
            <!-- w-0 min-w-full: the detail spans the table without widening its columns. It grows
                 open from zero height in CSS alone (starting: is @starting-style), with no measuring. -->
            <div class="grid w-0 min-w-full grid-rows-[1fr] transition-rows duration-150 ease-out starting:grid-rows-[0fr] motion-reduce:transition-none">
              <div class="min-h-0 overflow-hidden">
                <div class="flex flex-col gap-2 px-3 py-2">
                  <div class="flex items-start gap-2">
                    <div class="min-w-0 flex-1">
                      <!-- Detail Error -->
                      <Alert v-if="detailError" variant="destructive">
                        <AlertCircle class="size-4" />
                        <AlertTitle>{{ t('hswarm.v.jobs.failedToLoad') }}</AlertTitle>
                        <AlertDescription>{{ detailError }}</AlertDescription>
                      </Alert>

                      <!-- Detail Loading -->
                      <Skeleton v-else-if="isLoadingDetail" class="h-7 w-full" />

                      <!-- The summary: one line of facts, wrapping only on a narrow pane -->
                      <template v-else>
                        <div class="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                          <span class="min-w-0 max-w-full truncate text-sm font-medium" :title="selectedJobId ?? undefined">{{ summary.label || selectedJobId }}</span>
                          <Badge :variant="stateVariant(summary.state)">{{ summary.state || '–' }}</Badge>
                          <span
                            class="inline-flex flex-wrap gap-x-2 tabular-nums"
                            :title="summary.total != null ? t('hswarm.v.jobs.countsHint', { n: summary.total }) : undefined"
                          >
                            <span v-for="c in summary.counts" :key="c.key" :class="c.tone">{{ c.text }}</span>
                          </span>
                          <span class="font-mono tabular-nums" :title="summary.costHint">{{ summary.cost }}</span>
                          <span class="inline-flex items-center gap-1 text-muted-foreground" :title="summary.timeHint || undefined">
                            <Clock class="size-3.5 shrink-0" aria-hidden="true" />{{ summary.time }}
                          </span>
                          <!-- The chat that called it; a click opens it in Desk -->
                          <button
                            v-if="caller?.open"
                            type="button"
                            class="inline-flex min-w-0 max-w-64 items-center gap-1 rounded-sm text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            :title="t('hswarm.v.jobs.callerOpen')"
                            @click="openCaller"
                          >
                            <MessageSquare class="size-3.5 shrink-0" aria-hidden="true" />
                            <span class="truncate">{{ caller.name }}</span>
                          </button>
                          <span
                            v-else-if="caller"
                            class="inline-flex min-w-0 max-w-64 items-center gap-1 text-muted-foreground"
                            :title="t('hswarm.v.jobs.callerHint')"
                          >
                            <MessageSquare class="size-3.5 shrink-0" aria-hidden="true" />
                            <span class="truncate">{{ caller.name }}</span>
                          </span>
                        </div>
                        <p v-if="summary.error" class="mt-1 text-xs text-destructive">{{ summary.error }}</p>
                      </template>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      :aria-label="t('hswarm.v.jobs.closeSummary')"
                      :title="t('hswarm.v.jobs.closeSummary')"
                      aria-keyshortcuts="Escape"
                      @click="closeJob"
                    >
                      <X class="size-4" />
                    </Button>
                  </div>

                  <!-- Task results: one line per task under a heading that folds them (folded past
                       FOLD_AT tasks), in a box that scrolls instead of growing the page -->
                  <div
                    v-if="jobDetail?.results && !detailError && !isLoadingDetail"
                    class="flex flex-col gap-1.5 border-t pt-2"
                  >
                  <Collapsible v-model:open="resultsOpen">
                    <div class="flex min-w-0 items-center gap-1.5">
                      <CollapsibleTrigger as-child>
                        <button
                          type="button"
                          class="group flex min-w-0 items-center gap-1.5 rounded-md px-1 text-xs font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <ChevronRight
                            class="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
                            aria-hidden="true"
                          />
                          <span class="shrink-0">{{ t('hswarm.v.jobs.taskResults') }}</span>
                          <span class="truncate font-normal text-muted-foreground tabular-nums">({{ taskRows.length }}) {{ tallyText(taskCounts) }}</span>
                        </button>
                      </CollapsibleTrigger>
                      <InfoHint :text="t('hswarm.v.jobs.taskResultsHint', { n: FOLD_AT })" />
                    </div>
                    <CollapsibleContent>
                      <p v-if="resultsError" class="px-1 text-xs text-destructive">{{ resultsError }}</p>
                      <p v-else-if="!taskRows.length" class="px-1 text-xs text-muted-foreground">
                        {{ t('hswarm.v.jobs.noResults') }}
                      </p>
                      <template v-else>
                        <ul
                          class="scroll-slim flex max-h-96 flex-col overflow-y-auto rounded-lg border bg-card py-0.5"
                          :aria-label="t('hswarm.v.jobs.taskListLabel')"
                        >
                          <li v-for="task in shownTasks" :key="task.id">
                            <!-- One line: how it ended, its id, the model, the cost, the first line of its answer -->
                            <button
                              type="button"
                              class="flex h-7 w-full min-w-0 items-center gap-2 px-2.5 text-start text-xs transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                              :aria-expanded="openTask === task.id"
                              @click="toggleTask(task.id)"
                            >
                              <span class="relative inline-flex shrink-0" :class="task.mark.tone" :title="task.mark.label">
                                <component
                                  :is="task.mark.icon"
                                  class="size-3.5"
                                  :class="task.mark.spin ? 'animate-spin' : ''"
                                  aria-hidden="true"
                                />
                                <span class="sr-only">{{ task.mark.label }}</span>
                              </span>
                              <span class="w-24 shrink-0 truncate font-mono" :title="task.id">{{ task.id }}</span>
                              <span class="hidden w-36 shrink-0 truncate text-muted-foreground sm:block" :title="task.model || undefined">{{ task.model || '–' }}</span>
                              <span class="w-16 shrink-0 text-end font-mono tabular-nums text-muted-foreground" :title="t('hswarm.v.money.atListPrice')">{{ costText(task.cost) }}</span>
                              <span class="min-w-0 flex-1 truncate" :class="task.firstTone">{{ task.first || '–' }}</span>
                            </button>
                            <!-- Its whole answer, in a box of its own height that scrolls -->
                            <pre
                              v-if="openTask === task.id"
                              tabindex="0"
                              class="scroll-slim mx-2.5 mb-1.5 max-h-64 overflow-auto rounded-md border bg-background p-2 font-mono text-xs whitespace-pre-wrap wrap-break-word"
                            >{{ task.full }}</pre>
                          </li>
                        </ul>
                        <Button
                          v-if="taskRows.length > taskLimit"
                          variant="outline"
                          size="sm"
                          class="mt-1.5 w-full"
                          @click="taskLimit += TASK_PAGE"
                        >
                          {{ t('hswarm.v.jobs.taskShowMore', { n: Math.min(TASK_PAGE, taskRows.length - taskLimit), total: taskRows.length - taskLimit }) }}
                        </Button>
                      </template>
                    </CollapsibleContent>
                  </Collapsible>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </li>
      </ul>
      <p v-else class="px-1 py-6 text-center text-xs text-muted-foreground">
        {{ t('hswarm.v.jobs.filter.none') }}
      </p>

      <!-- More of the list, then the finished CliMayte tasks older than the ones read. -->
      <div v-if="matching.length > limit || hasOlder" class="flex gap-2">
        <Button v-if="matching.length > limit" variant="outline" size="sm" class="flex-1" @click="limit += PAGE">
          {{ t('hswarm.v.jobs.showMore', { n: Math.min(PAGE, matching.length - limit) }) }}
        </Button>
        <Button v-if="hasOlder" variant="outline" size="sm" class="flex-1" @click="showOlder">
          {{ t('climayte.showOlder') }}
        </Button>
      </div>
    </div>
  </div>
</template>
