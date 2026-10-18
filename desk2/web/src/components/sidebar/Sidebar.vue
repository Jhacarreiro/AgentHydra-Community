<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { NOTE_MAX, type ChatSummary, type CliMayteWorker, type CloudSession, type ExternalSession, type PinnedService, type SessionMetaPatch, type SwarmJob } from '@shared/protocol'
import { icons, shellGlyphs, sidebarIcons } from '@/lib/icons'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tip } from '@/components/ui/tooltip'
import AccountsPopover from '@/components/accounts/AccountsPopover.vue'
import HeadlessAudioButton from '@/components/sidebar/HeadlessAudioButton.vue'
import { useShellSource } from '@/components/shell/source'
import { unreadHold } from '@/components/shell/logic'
const CloudList = lazyPanel(() => import('@/components/cloud/CloudList.vue'))
const DevServersList = lazyPanel(() => import('@/components/servers/DevServersList.vue'))
import { useDevServers } from '@/components/servers/store'
import { useCloud } from '@/components/cloud/store'
import { ahSource, appShown, deskOnPcs, hitsOnThisPc, remoteSessions } from '@/components/cloud/logic'
import { activeOnly } from './active'
const HydraSidebar = lazyPanel(() => import('@/components/hydra/HydraSidebar.vue'))
import { actionError } from '@/lib/action-error'
import { copyTitle, duplicateSession, moveCodexSession, moveSession, settingsMissed, unassignCodexSession, unassignSession } from '@/components/session-header/ah'
import { accountChoices, codexAccountChoices, refreshAhInstances } from '@/components/session-header/instances'
import { peekHeader } from '@/components/session-header/state'
import { lazyPanel } from '@/lib/lazy-panel'
import { useSwarmJobs } from '@/lib/swarm-jobs'
import { useClock } from '@/lib/clock'
import { ahUpdateDot, hydraOpen, hydraShown, openSwarmInHydra, openWorkerInHydra } from '@/components/hydra/api'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { useFirstInterestSet } from '@/lib/first-interest'
import { createReusableTemplate, useEventListener } from '@vueuse/core'
import { ChevronRight, EyeOff, PanelRightClose, PanelRightOpen } from '@lucide/vue'
import { usePaneApi } from '@/components/panes/api'
import { applyWaitingRelease, releaseApplying, releaseApplyError, releaseWaiting } from '@/lib/ah-release'
import { clickUpdate, footerUpdate, updateClicking } from '@/lib/desk-update-row'
import { rememberForUpdate } from '@/lib/whats-new'
import { checkServerUpdate, restartServer, updateOffer } from '@/lib/server-update'
import TaskRows from './TaskRows.vue'
import SubBadges from './SubBadges.vue'
import FoldButton from './FoldButton.vue'
import { folded, toggleFolded } from './folded'
import { CHROME_OPEN, SIDEBAR_MAX, SIDEBAR_MIN, clampSidebarWidth } from './width'
import { dropSide, type SidebarSide } from './side'
import { expanded, rowSubItems, subModes } from './subitems'
import RunningBadge from './RunningBadge.vue'
import ProjectMenuItems from './ProjectMenuItems.vue'
import GroupDashboardButton from '@/components/dashboard/GroupDashboardButton.vue'
import TodoButton from '@/components/fourman/TodoButton.vue'
import { refreshDashboards } from '@/components/dashboard/store'
import AutoCategorizeDialog from './AutoCategorizeDialog.vue'
import {
  addRemoteToDeskGroups,
  addToDeskGroups,
  addedStatus,
  addedPulse,
  isAddedRow,
  nestTasks,
  runningJobsIn,
  runningTasksIn,
  showTasks,
  type AddedRow,
  type KnownChat,
  type NestedTasks,
  type NestRow,
  type SeenJobs,
  type TaskNode
} from './tasks'
import ChatRow from './ChatRow.vue'
import SidebarTools from './SidebarTools.vue'
import ExternalRow from './ExternalRow.vue'
import SearchHitRow from './SearchHitRow.vue'
import {
  IDLE_SEARCH,
  createSearchRunner,
  everywhereRows,
  moveCursor,
  resolveCursor,
  searchEscape,
  searchTargets,
  shownSessionIds,
  type SearchState
} from './search'
import {
  accountFace,
  accountMenu,
  accountNum,
  bulkMenu,
  chatRow,
  childrenByRow,
  entryKey,
  entryRunning,
  foldChildren,
  externalGlyph,
  externalRow,
  isActive,
  onlyActive,
  statusGlyph,
  groupChats,
  groupChoices,
  groupOrderKey,
  HIDE_TITLE,
  hideable,
  isOrange,
  raiseNewlyOrange,
  withThreads,
  recordCloudOrder,
  recordDeskOrder,
  moveTarget,
  parseFilter,
  projectOfGroup,
  resumeCommand,
  revealChat,
  rowIdentity,
  lastActionLine,
  rowPatch,
  runningSessionIds,
  deskGlyphs,
  deskNewFolder,
  rowMenu,
  runPulse,
  SWARM_RUNNING,
  type ChatGroup,
  type RowMenuEntry,
  type RowMenuItem,
  type RowState,
  type SidebarEntry,
  type StatusGlyph,
  type SidebarFilter,
  type SidebarGroups,
  emptyListText,
  UNASSIGNED
} from './logic'
import { useSidebarOrder } from './order'
import { chatServices } from './services'
import { useHiddenGroups } from './hidden'
import { compactSidebar } from './compact'
import { MENU_CONTENT, MENU_ITEM, focusFirstItem } from './menuClasses'
import { useRowDrag } from './rowDrag'
import { NO_PICKS, pickClick, prunePicks, type Picks } from './picked'
import { leaveUnlessFiltered } from '@/lib/row-leave'

// The real sidebar: 288 wide on #111111, 36px left free at the top for the chrome bar, the New row (the
// real app's Projects, Artifacts, Customize and More rows are left out on purpose), then Pinned and one
// group per folder holding our chats and the sessions running elsewhere, and a 44px footer with the
// profile (account) control and the Settings gear.
// Collapse mode (collapse.ts): `collapsible` shows the button that folds the window; `fill` is the folded view, the
// sidebar filling the whole window, with its own expand button and no grip or resize handle.
const props = withDefaults(
  defineProps<{ width?: number; side?: SidebarSide; /** Gallery: open the account popup at once. */ accountsOpen?: boolean; collapsible?: boolean; fill?: boolean }>(),
  { width: 288, side: 'left', accountsOpen: false, collapsible: false, fill: false }
)
const emit = defineEmits<{ resize: [width: number]; side: [side: SidebarSide]; 'side-preview': [side: SidebarSide | null]; collapse: []; expand: [] }>()

// Dragged from 200 to 420 (width.ts); the chrome bar over its top keeps the 294 its buttons need and reaches past a
// narrower sidebar.

const src = useShellSource()
const selected = computed(() => src.selected.value)
const selectedChatId = computed(() => (selected.value.kind === 'chat' ? selected.value.id : null))

const selectedExternalId = computed(() => (selected.value.kind === 'external' ? selected.value.id : null))
// The cloud list's rows are sessions: an open chat of Desk's own is the row of its session.
const selectedCloudId = computed(() => {
  const s = selected.value
  return s.kind === 'chat' ? (src.chats.value.find((c) => c.id === s.id)?.sessionId ?? null) : selectedExternalId.value
})
const accountsOpen = ref(props.accountsOpen)

const storage = typeof localStorage === 'undefined' ? null : localStorage

// Search, filter (remembered), archived
const searchOpen = ref(false)
const query = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const FILTER_KEY = 'hydra-desk.sidebar.filter'
function readFilter(): SidebarFilter {
  try {
    return parseFilter(storage?.getItem(FILTER_KEY))
  } catch {
    return 'active'
  }
}
const filter = ref<SidebarFilter>(readFilter())
watch(filter, (f) => storage?.setItem(FILTER_KEY, f))

function openSearch() {
  searchOpen.value = true
  nextTick(() => searchInput.value?.focus())
}
function closeSearch() {
  searchOpen.value = false
  query.value = ''
  cloud.search.value = ''
}

// Hydra Desk 2: the chrome bar's cloud button shows the cloud list here instead (every session of both
// PCs, components/cloud). The search box then searches it: AgentHydra matches titles over everything in
// the list's scope, or over everything at all unless "Only this view" is ticked.
const cloud = useCloud()
// The title bar's Dev servers button: DevWebUI's projects and servers take the list's place (components/servers).
const devServers = useDevServers()
const searchText = computed({
  get: () => (cloud.on.value ? cloud.search.value : query.value),
  set: (v: string) => {
    if (cloud.on.value) cloud.search.value = v
    else query.value = v
  }
})
// A cloud row opens as an outside session on Desk's side, with AgentHydra's session header over it
// (AgentHydra, if it is open, slides away: DeskFrame); a row added for running work opens what it stands for.
function openCloud(r: CloudSession) {
  const added = addedRows.value.get(r.id)
  if (added) openAdded(added)
  else src.select({ kind: 'external', id: r.id })
}
function onCloudSearchKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    const first = cloudSearching.value ? cloud.groups.value[0]?.rows[0] : undefined
    if (first) openCloud(first)
  } else if (e.key === 'Escape') {
    if (searchEscape(e, cloud.search.value) === 'clear') cloud.search.value = ''
    else closeSearch()
  }
}

// The order rows keep (the owner, 2026-10-04: sending a message must not reorder the list; rows are dragged into the
// order wanted), the one the cloud list keeps too (order.ts). New ones join at the top. Folder groups are not kept
// in it: they are listed A-Z (logic.ts sortFolders).
const { order, save: saveOrder } = useSidebarOrder()

// While AgentHydra is open, a tab of it with a sidebar of its own (HSwarm's tree) has it drawn here.
const hydraModel = computed(() => hydraShown.value?.model ?? null)

// Groups hidden with their header's right-click (hidden.ts), out of the list unless the Filter menu's Show hidden.
const hiddenGroups = useHiddenGroups()
// A group's header menu mounts on the first hover, focus or press on it (lib/first-interest.ts).
const groupMenus = useFirstInterestSet()
const [DefineGroupHead, ReuseGroupHead] = createReusableTemplate<{ group: ChatGroup }>()

// The Project Hydra projects the New screen loaded (its icon goes left of a group's heading). Read from the cache that screen
// keeps, so the list never waits for it and nothing polls: read at start (asked once when nothing is cached yet), and again
// whenever the screen changes, by when a New screen that just showed has refreshed it.
const keptProjects = ref(src.cachedProjects?.()?.projects ?? [])
if (!keptProjects.value.length)
  void src
    .projects?.()
    .then((r) => (keptProjects.value = r.projects))
    .catch(() => {})
watch(selected, () => {
  keptProjects.value = src.cachedProjects?.()?.projects ?? keptProjects.value
})

// Show only local (the Filter menu's Computer filter) narrows this list as it does the cloud list, once the cloud
// store knows this PC's name (it asks with the cloud off too): another PC's synced chats leave it.
const deskPcs = computed(() => (cloud.loaded.value ? cloud.scopes.value.pcs : null))
const onPcs = computed(() => deskOnPcs(src.chats.value, src.external.value, deskPcs.value, cloud.thisPc.value, cloud.on.value))
const groups = computed(() =>
  groupChats(onPcs.value.chats, {
    query: query.value,
    filter: filter.value,
    external: onPcs.value.external,
    // The Filter menu's Apps (cloud store scopes) narrow this list's outside sessions too; Claude alone by default.
    showApp: (s) => appShown(ahSource(s.source), cloud.scopes.value.apps),
    order: order.value,
    hidden: hiddenGroups.hidden.value,
    showHidden: hiddenGroups.showHidden.value
  })
)
/** The desk list's own groups, without the rows added for running work (`deskShown` below has those too). */
const ownGroups = computed<ChatGroup[]>(() => {
  const g = groups.value
  return [...(g.pinned ? [g.pinned] : []), ...g.folders, ...(g.archived ? [g.archived] : [])]
})
const filtering = computed(() => query.value.trim() !== '' || filter.value !== 'active' || deskPcs.value !== null || activeOnly.value)
// Rows drag to another place in their own group (rowDrag.ts); not while a search or a filter narrows the list.
const rowDrag = useRowDrag()
const rowsDraggable = (g: ChatGroup) => !filtering.value && g.key !== 'archived'
const rowLeave = leaveUnlessFiltered([query, filter, deskPcs])
const emptyText = computed(() =>
  emptyListText({ searching: query.value.trim() !== '', hiddenOut: !!groups.value.hiddenOut, filter: filter.value, activeOnly: activeOnly.value })
)

// Hydra Desk 2: with the chrome bar's CliMayte button on, each row of the list shown (the cloud list or the
// desk list, the rows each draws) lists the CliMayte tasks it handed out under it, a manager's wave one step
// further in, each task once (tasks.ts), another PC's under its chat too (the chat sync brings that chat here
// with the same session id; owner, 2026-10-04: "Under the chat which spawned them. Not as its own stand alone
// table"). A running task no drawn row lists (its chat is another PC's and not synced here, nothing says which
// chat started it, or the filter or the list leaves that chat out) is still shown: the chat that started it,
// else the task itself, is added as a row of its folder's group, drawn as the list draws its own rows, another
// PC's with a cloud (owner, 2026-10-05: "I shouldn't even be able to tell the difference between ones on his
// computer and mine, besides them having a Cloud icon"), so every task AgentHydra's CliMayte list shows running
// is here (owner, 2026-10-05: "Is one smaller than six?"). The other PCs' tasks only with the cloud on (owner,
// 2026-10-05: "when cloud is turned off, it shouldn't show these"): the desk store keeps them apart from
// src.workers so they never count as this PC's (stores/desk.ts splitWorkers); a source without them (the
// Gallery) has none.
// HSwarm's jobs, pushed by the server into the desk store (lib/swarm-jobs.ts); the other PCs' only with the cloud on.
// The cloud list draws them under its rows as the desk list does (a running job whose caller no row is adds a row for it).
const swarmJobs = useSwarmJobs(cloud.on)
const remoteWorkers = computed(() => (cloud.on.value ? (src.remoteWorkers?.value ?? []) : []))
/**
 * Every chat the window knows by its session id: the cloud list's answer (the other PC's synced chats among
 * them), then this PC's outside sessions and chats, whose facts win as the desk list's. A row added for a chat
 * no drawn row is takes its title and folder from here.
 */
const knownChats = computed(() => {
  const out = new Map<string, KnownChat>()
  for (const r of cloud.sessions.value) out.set(r.id, { title: r.title, cwd: r.cwd, at: r.lastActivityAt })
  for (const s of src.external.value) if (s.source !== 'climayte') out.set(s.id, { title: s.title, cwd: s.cwd, at: s.lastActivityAt })
  for (const c of src.chats.value) if (c.sessionId) out.set(c.sessionId, { title: c.title, cwd: c.cwd || null, at: c.updatedAt })
  return out
})
// The cloud button keeps this list as it is and adds the other PCs' sessions it does not list (owner, 2026-10-10: the
// cloud toggle "should show exactly the same as with the cloud toggled off. It should just also show me any external
// chats from the cloud"; cloud/logic.ts remoteSessions), each in the group of the folder of its name here (deskShown).
// A search typed with the cloud on answers in the cloud list instead (AgentHydra's best matches over everything), and
// the Filter menu's Select multiple sessions ticks rows there (CloudList.vue).
const remote = computed<ExternalSession[]>(() => {
  if (!cloud.on.value) return []
  const listed = new Set([...src.external.value.map((s) => s.id), ...src.chats.value.flatMap((c) => (c.sessionId ? [c.sessionId] : []))])
  return remoteSessions(cloud.sessions.value, listed, cloud.thisPc.value, cloud.scopes.value.pcs)
})
/** The cloud's row of each session `remote` added, by id: its menu is the cloud list's (cloudMenu). */
const remoteRows = computed(() => {
  const ids = new Set(remote.value.map((s) => s.id))
  return new Map(cloud.sessions.value.filter((r) => ids.has(r.id)).map((r) => [r.id, r]))
})
const cloudSearching = computed(() => cloud.on.value && cloud.searching.value && cloud.search.value.trim() !== '')
const cloudListShown = computed(() => cloudSearching.value || (cloud.on.value && cloud.selectMode.value))
/** The CloudList is what the sidebar draws: the template's chain puts Hydra's tree and the dev servers first. */
const cloudShown = computed(() => cloudListShown.value && !hydraModel.value && !devServers.on.value)

// The HSwarm jobs seen so far, kept across polls (tasks.ts SeenJobs): a task HSwarm sent stays under the chat its job
// named while HSwarm's list lacks the job, instead of turning into a row of its own and back (owner, 2026-10-09). A
// task still waiting for its job is drawn nowhere for a while (ROUTED_WAIT_MS, counted from when this list began
// listening at the latest); while one waits the nesting is worked out again on a 5 s tick, so it shows when the wait
// ends even if nothing else changes.
const seenJobs: SeenJobs = new Map()
const listeningSince = Date.now()
const heldTick = useClock(5000)
// The tasks and jobs every row knows (its threads, whether drawn or not: a row whose threads run shows running, owner,
// 2026-10-10), and what the list draws of them: nothing while the CliMayte toggle is off (its lines, badges and added rows).
const threadNesting = computed<NestedTasks | null>(() => {
  const out = nestAll()
  if (out?.held) void heldTick.value
  return out
})
const nesting = computed<NestedTasks | null>(() => (showTasks.value ? threadNesting.value : null))
function nestAll(): NestedTasks | null {
  const workers = [...src.workers.value, ...remoteWorkers.value]
  const jobs = swarmJobs.value
  const o = { seenJobs, now: Date.now(), since: listeningSince }
  // The rows the desk list draws of its own, as groupChats picks them (never a CliMayte worker's own session, nor
  // a session that is one of our chats), and the other PCs' the cloud adds; a row in a folded group still holds its
  // tasks, and the group's heading counts the running ones (RunningBadge). A chat stands for its worker by id too, so
  // one still queued (no session yet) is not listed again as a task.
  const rows: NestRow[] = [
    ...ownGroups.value.flatMap((g) =>
      g.entries.map((e) =>
        e.kind === 'chat'
          ? { key: `chat:${e.id}`, sessionIds: e.chat.sessionId ? [e.chat.sessionId] : [], workerId: e.chat.workerId }
          : { key: `external:${e.id}`, sessionIds: [e.session.id] }
      )
    ),
    ...remote.value.map((s) => ({ key: `external:${s.id}`, sessionIds: [s.id] }))
  ]
  return nestTasks(rows, workers, jobs, knownChats.value, o)
}
/** The rows added for running work no drawn row lists (tasks.ts AddedRow), by id. */
const addedRows = computed(() => new Map((nesting.value?.added ?? []).map((a) => [a.id, a])))
/** The added row a row key (`external:` or `cloud:`, then its id) is, if any: among the threads (every one), and among the drawn ones. */
const threadAddedAt = (key: string) => (threadNesting.value?.added ?? []).find((a) => a.id === key.slice(key.indexOf(':') + 1))
const tasksOf = (key: string) => threadNesting.value?.byRow.get(key) ?? threadAddedAt(key)?.nodes ?? null
const jobsOf = (key: string) => threadNesting.value?.jobsByRow.get(key) ?? threadAddedAt(key)?.jobs ?? null
/** An added row that is itself a running HSwarm job no chat is known to have called: its dot pulses blue and a folded heading counts it with the jobs. */
const jobRow = (a: AddedRow | undefined): boolean => !!a?.job?.active && !a.worker
/** The HSwarm jobs a folded group's heading counts under a row: its jobs, and the job an added row is itself. */
const jobsCounted = (key: string): SwarmJob[] | null => {
  const a = threadAddedAt(key)
  return jobRow(a) ? [a!.job!, ...(jobsOf(key) ?? [])] : jobsOf(key)
}
/** What a row draws of its tasks and jobs: lines, a badge, or both once the badge is opened (subitems.ts). Nothing while the toggle is off. */
const subOf = (key: string, tasks: TaskNode[] | null, jobs: SwarmJob[] | null) => rowSubItems(key, tasks, jobs, { tasks: subModes.tasks.value, jobs: subModes.jobs.value }, expanded.value)
const rowSub = (key: string) => subOf(key, nesting.value ? tasksOf(key) : null, nesting.value ? jobsOf(key) : null)

// The desk list as drawn: its own groups, the rows added for running work no row of it lists, each in its folder's
// group among the list's own rows (tasks.ts addToDeskGroups; this PC's, and with the cloud on every PC's the Computer
// filter keeps), and with the cloud on the other PCs' sessions it adds (`remote`, tasks.ts addRemoteToDeskGroups);
// not while a search or the Archived filter narrows it to the rows it matches.
const deskShown = computed<SidebarGroups>(() => {
  const g = groups.value
  const narrowed = !!query.value.trim() || filter.value === 'archived'
  const pcs = cloud.scopes.value.pcs
  const keptPc = (a: AddedRow) => (cloud.on.value ? pcs === null || pcs.includes(a.pc ?? cloud.thisPc.value) : !a.pc)
  const added = narrowed ? [] : (nesting.value?.added ?? []).filter(keptPc)
  const others = narrowed ? [] : remote.value
  if (!added.length && !others.length) return g
  const placing = { order: order.value, hidden: hiddenGroups.hidden.value, showHidden: hiddenGroups.showHidden.value }
  const withAdded = added.length ? addToDeskGroups(g.folders, added, placing) : g.folders
  return { ...g, folders: others.length ? addRemoteToDeskGroups(withAdded, others, placing) : withAdded }
})
/** The desk list's groups before Active only leaves rows out: a row's threads count the nested rows among them, drawn or not. */
const allGroups = computed<ChatGroup[]>(() => {
  const g = deskShown.value
  return [...(g.pinned ? [g.pinned] : []), ...g.folders, ...(g.archived ? [g.archived] : [])]
})
const groupList = computed<ChatGroup[]>(() => (activeOnly.value ? onlyActive(allGroups.value, entryGlyph) : allGroups.value))
// The chats started from each row, which sit under it (logic.ts nestChildren), and the list as drawn: a folded row's
// left out (folded.ts), the open one kept in sight; all of them while a search is typed, which shows what it matches.
const childrenOf = computed(() => childrenByRow(groupList.value))
const threadChildren = computed(() => childrenByRow(allGroups.value))
/** The desk row key of each session id, for the cloud list's dot (a row's threads are found by its key). */
const deskKeyOf = computed(() => {
  const out = new Map<string, string>()
  for (const e of allGroups.value.flatMap((g) => g.entries)) {
    const sid = e.kind === 'chat' ? e.chat.sessionId : e.session.id
    if (sid && !out.has(sid)) out.set(sid, entryKey(e))
  }
  return out
})
const isOpenEntry = (e: SidebarEntry) => (e.kind === 'chat' ? selectedChatId.value === e.id : selectedExternalId.value === e.id)
const drawnList = computed<ChatGroup[]>(() => (query.value.trim() ? groupList.value : foldChildren(groupList.value, folded.value, isOpenEntry)))
/** A row's fold button (FoldButton.vue): how many chats sit under it, whether they show, and what the hidden ones do. */
const foldOf = (key: string) => {
  const kids = childrenOf.value.get(key)
  if (!kids || query.value.trim()) return null
  const open = !folded.value.has(key)
  return { count: kids.length, open, running: !open && kids.some(entryRunning), needsYou: !open && kids.some((e) => entryGlyph(e).tone === 'warning') }
}
/** A group's icon: its Project Hydra project's icon, or null for none (projectOfGroup). The cloud list uses it too. */
const iconOfGroup = (g: Pick<ChatGroup, 'key' | 'cwd' | 'label'>) => projectOfGroup(g, keptProjects.value)?.icon ?? null
/** Each group's heading icon, by group key. */
const groupIcons = computed(() => new Map(groupList.value.map((g) => [g.key, iconOfGroup(g)])))
/** The folder of a group's project (projectOfGroup), for its right-click menu: most project groups are named groups
 *  the projects feature files chats into, with no folder of their own. The cloud list uses it too. */
const projectFolderOf = (g: Pick<ChatGroup, 'key' | 'cwd' | 'label'>) => projectOfGroup(g, keptProjects.value)?.path ?? null
/** What a desk group's menu describes: its project's folder, else its own, else the folder its newest chat works in. */
const menuFolderOf = (g: ChatGroup) => projectFolderOf(g) ?? deskNewFolder(g)
// A group head's dashboard button (both lists' GroupDashboardButton) reads the one dashboards list: read now, when the
// window comes back and when another chat is picked, so a site a chat just wrote gets its button without a reload.
void refreshDashboards()
useEventListener(window, 'focus', () => void refreshDashboards())
watch(
  () => src.selected.value,
  () => void refreshDashboards()
)
// A row the plain list shows that the order lacks joins it at the top, so it keeps the place it appeared in, and
// so does one only the cloud list had shown (recordDeskOrder); any other saved one never moves; a row that just
// turned orange goes to the top of its group. An added row joins as a new row does.
const wasOrange = new Map<string, boolean>()
watch(
  deskShown,
  (g) => {
    if (query.value.trim() || filter.value !== 'active') return
    const shownEntries = [...(g.pinned?.entries ?? []), ...g.folders.flatMap((f) => f.entries)]
    const others = remoteRows.value
    const shownRows = shownEntries.filter((e) => !others.has(e.id)).map((e) => e.id)
    const next = recordCloudOrder(
      recordDeskOrder(order.value, shownRows),
      shownEntries.filter((e) => others.has(e.id)).map((e) => e.id)
    )
    const rows = raiseNewlyOrange(next.rows, shownEntries, wasOrange)
    for (const e of shownEntries) wasOrange.set(e.id, isOrange(e))
    saveOrder({ ...next, rows })
  },
  { immediate: true }
)
// The cloud list as drawn (cloudListShown): a search's answer, AgentHydra's best matches, or the list Select multiple
// sessions ticks rows in.
const cloudGroups = computed(() => {
  const groups = cloud.groups.value
  if (!activeOnly.value) return groups
  return groups.flatMap((g) => {
    const rows = g.rows.filter((r) => isActive(cloudDot(r.id)))
    return rows.length ? [{ ...g, rows }] : []
  })
})

/** The running CliMayte tasks and HSwarm jobs under a desk-list group's rows, and its rows that run, for its heading while it is folded. */
const foldedRunning = computed(() => {
  const out = new Map<string, { tasks: number; jobs: number; chats: number }>()
  for (const g of groupList.value) {
    if (!collapsed.value.has(g.key)) continue
    const tasks = nesting.value ? runningTasksIn(g.entries.map((e) => tasksOf(`${e.kind}:${e.id}`))) : 0
    const jobs = nesting.value ? runningJobsIn(g.entries.map((e) => jobsCounted(`${e.kind}:${e.id}`))) : 0
    const chats = g.entries.filter((e) => entryRunning(e) && !jobRow(addedRows.value.get(e.id))).length
    if (tasks || jobs || chats) out.set(g.key, { tasks, jobs, chats })
  }
  return out
})
/** An added row's state, as its dot shows it (tasks.ts addedStatus); null for any other row. */
const addedState = (id: string) => {
  const a = addedRows.value.get(id)
  return a ? addedStatus(a) : null
}
/** The cloud list's rows that run: the ones the desk knows as running, and the added rows whose worker runs (one that is a job counts with the jobs). */
const runningSessions = computed(() => runningSessionIds(src.chats.value, onPcs.value.external))
const sessionRunning = (id: string) => runningSessions.value.has(id) || (addedState(id) === 'working' && !jobRow(addedRows.value.get(id)))
const deskDots = computed(() => deskGlyphs(src.chats.value, onPcs.value.external))
/**
 * An added row's dot, in both lists: a session's dot for its state (addedStatus), save that a row that is itself a
 * running HSwarm job pulses blue as the job's line does, blue being HSwarm's alone (owner, 2026-10-05). Undefined
 * for any other row.
 */
const addedGlyph = (id: string): StatusGlyph | undefined => {
  const a = addedRows.value.get(id)
  if (!a) return undefined
  return jobRow(a) ? SWARM_RUNNING : externalGlyph({ status: addedStatus(a), unread: false })
}
/**
 * The running threads under a row: its CliMayte tasks and HSwarm jobs, and its nested rows that run. A nested row counts by
 * its own state, never its parent's, so the recursion stops at one level down.
 */
const runningThreads = (key: string): number =>
  runningTasksIn([tasksOf(key)]) + runningJobsIn([jobsOf(key)]) + (threadChildren.value.get(key) ?? []).filter(entryRunning).length
/** A cloud row's dot: an added row's, or its desk row's, with the threads of that row counted. */
const cloudDot = (id: string): StatusGlyph | undefined => {
  const added = addedGlyph(id)
  if (added) return added
  const dot = deskDots.value.get(id)
  const key = deskKeyOf.value.get(id)
  return dot && key ? withThreads(dot, runningThreads(key)) : dot
}
/**
 * A desk-list entry's dot, as its row draws it: a chat's, or an outside session's (an added row's, when it is one), and
 * a row with running threads runs too (withThreads). Shared by the Active only filter, the folded headings and both dims.
 */
const entryGlyph = (e: SidebarEntry): StatusGlyph => {
  const base = e.kind === 'chat' ? statusGlyph(e.chat) : (addedGlyph(e.id) ?? externalGlyph(e.session))
  return withThreads(base, runningThreads(entryKey(e)))
}
/** Back to the unfiltered list: the Active default and Active only off. */
const showAll = () => {
  activeOnly.value = false
  filter.value = 'active'
}
/** How an added row's cloud pulses, from the work it stands for and lists (tasks.ts addedPulse); undefined for any other row. */
const cloudPulse = (id: string) => {
  const a = addedRows.value.get(id)
  return a ? addedPulse(a) : undefined
}
/** An HSwarm job opens on AgentHydra's HSwarm page, selected in its list (the id goes to App.vue's deskSwarmAsk watch). */
const openJob = (j: SwarmJob) => openSwarmInHydra(j.id)
/** A task with a session here opens its transcript; one still queued, or another PC's, opens on CliMayte's tab. */
function openTask(w: CliMayteWorker) {
  if (w.sessionId && !w.pc) src.select({ kind: 'external', id: w.sessionId })
  else openWorkerInHydra(w.id, w.pc)
}
/**
 * An added row opens what it stands for: its worker or its job, this PC's chat (a Desk chat, else its
 * session's transcript), else, another PC's chat, its first task or job there.
 */
function openAdded(a: AddedRow) {
  if (a.worker) return openTask(a.worker)
  if (a.job) return openJob(a.job)
  if (a.sessionId && !a.pc) {
    const chat = src.chats.value.find((c) => c.sessionId === a.sessionId)
    if (chat) src.select({ kind: 'chat', id: chat.id })
    else src.select({ kind: 'external', id: a.sessionId })
    return
  }
  const first = a.nodes[0]?.worker
  if (first) openTask(first)
  else if (a.jobs[0]) openJob(a.jobs[0])
}

// The chosen chat lands visibly: its group opens and its row scrolls into view (a new chat is the
// first row of its group). One the filter or the search hides (a chat started while Archived is on)
// brings the list that shows it back, and one in a hidden group turns Show hidden on (its group stays
// hidden for when that goes off again); one picked from the Everywhere rows leaves the search as it is.
const groupOf = (id: string) => groupList.value.find((g) => g.entries.some((e) => e.kind === 'chat' && e.id === id))
watch(selectedChatId, (id) => {
  if (!id) return
  let group = groupOf(id)
  const chat = group ? null : src.chats.value.find((c) => c.id === id)
  if (chat && !everywhere.value.some((r) => r.view.kind === 'chat' && r.view.id === id)) {
    const shown = revealChat(chat, filter.value)
    query.value = shown.query
    filter.value = shown.filter
    group = groupOf(id)
    if (!group && groups.value.hiddenOut) {
      hiddenGroups.setShowHidden(true)
      group = groupOf(id)
    }
  }
  if (group && collapsed.value.has(group.key)) toggleGroup(group.key)
  nextTick(() => {
    const row = root.value?.querySelector<HTMLElement>('[aria-current="page"]')
    row?.closest('section')?.querySelector('header')?.scrollIntoView({ block: 'nearest' })
    row?.scrollIntoView({ block: 'nearest' })
  })
})

// Collapsed groups, remembered
const COLLAPSED_KEY = 'hydra-desk.sidebar.collapsed'
function readCollapsed(): string[] {
  try {
    const v = JSON.parse(storage?.getItem(COLLAPSED_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}
const collapsed = ref(new Set(readCollapsed()))
function toggleGroup(key: string) {
  const next = new Set(collapsed.value)
  if (!next.delete(key)) next.add(key)
  collapsed.value = next
  storage?.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
}

// AgentHydra's transcript search under the title matches ("Everywhere"), debounced. The arrow keys
// move through both lists, Enter opens, Escape clears the box and then closes it.
const search = ref<SearchState>(IDLE_SEARCH)
const runner = createSearchRunner({ run: (q) => src.search(q), onChange: (s) => (search.value = s) })
const everywhere = computed(() => everywhereRows(cloud.on.value ? search.value.hits : hitsOnThisPc(search.value.hits, [...cloud.sessions.value, ...src.external.value], cloud.thisPc.value), src.chats.value, shownSessionIds(groupList.value, collapsed.value)))
const targets = computed(() => (searchOpen.value ? searchTargets(drawnList.value, collapsed.value, everywhere.value) : []))
// The cursor is its row (kind and id) and the place it was last at, for when that row goes away.
const cursor = ref<{ key: string | null; at: number }>({ key: null, at: -1 })
const cursorAt = computed(() => resolveCursor(targets.value, cursor.value.key, cursor.value.at))
const cursorKey = computed(() => targets.value[cursorAt.value]?.key ?? null)
const setCursor = (at: number) => (cursor.value = { key: targets.value[at]?.key ?? null, at })
// Its row gone, the cursor takes the row now at its place, and follows that one from then on.
watch(cursorKey, (key) => key !== cursor.value.key && setCursor(cursorAt.value))
watch(query, (q) => {
  runner.input(q)
  setCursor(-1)
})
onBeforeUnmount(runner.stop)
function onSearchKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    setCursor(moveCursor(cursorAt.value, e.key === 'ArrowDown' ? 1 : -1, targets.value.length))
    nextTick(() => root.value?.querySelector('[data-search-cursor]')?.scrollIntoView({ block: 'nearest' }))
  } else if (e.key === 'Enter') {
    // A search that failed or found AgentHydra offline is asked again.
    if (search.value.phase === 'failed' || search.value.phase === 'offline') runner.input(query.value)
    const view = targets.value[Math.max(0, cursorAt.value)]?.view
    // A row added for running work is no session of its own: it opens what it stands for, as its click does.
    const added = view?.kind === 'external' ? addedRows.value.get(view.id) : undefined
    if (added) openAdded(added)
    else if (view) src.select(view)
  } else if (e.key === 'Escape') {
    if (searchEscape(e, query.value) === 'clear') query.value = ''
    else closeSearch()
  }
}

// Row actions: one menu for our chats and outside sessions. A chat's marks are the chat's; an outside
// session's are Hydra Desk's overlay on it (its own files are never touched, so it has no Delete).
type Row = { kind: 'chat'; chat: ChatSummary } | { kind: 'external'; session: ExternalSession }
/** The chats Delete asks about: one row's, or the picked rows' (bulkMenu). */
const deleting = ref<ChatSummary[] | null>(null)
const groupNames = computed(() => groupChoices(src.chats.value, onPcs.value.external))
const stateOf = (row: Row): RowState => (row.kind === 'chat' ? chatRow(row.chat) : externalRow(row.session))
// A row action that failed says so under the list, with the server's reason, until the next one.
const rowError = actionError
function attempt(what: string, run: Promise<unknown>) {
  rowError.value = null
  void run.catch((err: unknown) => (rowError.value = `${what} failed: ${err instanceof Error ? err.message : String(err)}`))
}
function mark(row: Row, patch: SessionMetaPatch & { title?: string }) {
  // A hand mark the window must not undo by itself when the item is open (shell/logic.ts UnreadHold).
  if (patch.unread !== undefined) unreadHold.mark(row.kind === 'chat' ? row.chat.id : row.session.id, patch.unread)
  attempt('The change', row.kind === 'chat' ? src.updateChat(row.chat.id, patch) : src.updateSessionMeta(row.session.id, patch))
}
/** The service a Pin service item names; Claude, the default, is no pin (null). */
function pinned(value: string | undefined): PinnedService | null {
  return value === 'codex' || value === 'chatgpt' ? value : null
}
function act(row: Row, item: RowMenuItem) {
  const state = stateOf(row)
  const patch = rowPatch(item, state)
  if (patch) return mark(row, patch)
  if (item.action === 'stop' && row.kind === 'chat') attempt('Stop', src.interrupt(row.chat.id))
  else if (item.action === 'delete' && row.kind === 'chat') deleting.value = [row.chat]
  else if (item.action === 'fork') attempt('Fork', row.kind === 'chat' ? src.forkChat(row.chat.id) : src.forkExternal(row.session.id))
  else if (item.action === 'pinService' && row.kind === 'chat') attempt('Pin service', src.updateChat(row.chat.id, { service: pinned(item.value) }))
  else if (item.action === 'newGroup') {
    groupDraft.value = ''
    naming.value = [row]
  } else if (item.action === 'reveal') attempt('Opening the folder', src.revealFolder(state.cwd))
  else if (item.action === 'copyResume' && state.sessionId) attempt('Copy', navigator.clipboard.writeText(resumeCommand(state.sessionId)))
  else if (item.action === 'copySessionId' && state.sessionId) attempt('Copy', navigator.clipboard.writeText(state.sessionId))
  else if (item.action === 'copyId' && item.value) attempt('Copy', navigator.clipboard.writeText(item.value))
  else if (item.action === 'moveToAccount' && state.movable) void moveToAccount(state.id, row.kind === 'chat' ? row.chat.title : row.session.title, item)
  else if (item.action === 'note') openNote(row)
  else if (item.action === 'unassign' && row.kind === 'external' && state.movable) void unassign(row.session, state)
  else if (item.action === 'duplicateToAccount' && state.movable) void duplicate(state.id, row.kind === 'chat' ? row.chat.title : row.session.title, item)
}

// Move to account: AgentHydra's migrate, as the session header's Migrate runs it (one move at a time, a move ends a
// running turn); for a Codex chat (a `codex:` account), AgentHydra's Codex move: copy, verify, archive the original.
// It takes a while (the target app imports the chat), so the list says it is moving and how it went.
const moving = ref(false)
const rowNote = ref<string | null>(null)
let rowNoteTimer: ReturnType<typeof setTimeout> | null = null
function noteRow(text: string | null, forMs = 0) {
  if (rowNoteTimer) clearTimeout(rowNoteTimer)
  rowNoteTimer = null
  rowNote.value = text
  if (text && forMs) rowNoteTimer = setTimeout(() => (rowNote.value = null), forMs)
}
onBeforeUnmount(() => rowNoteTimer && clearTimeout(rowNoteTimer))
const codexBusy = (s: ExternalSession) => s.source === 'codex' && (s.status === 'working' || s.status === 'needs_you')
const BUSY_MOVE = 'Another move is still running. Try again when it ends.'
const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err))
/** How one move, unassign or copy went: the note the list shows for a while, or why it did not happen. */
type MoveOutcome = { ok: true; note: string; forMs: number } | { ok: false; error: string }
/** The end of every move: the lock off, and the accounts and the cloud list read again. */
function settleMove() {
  moving.value = false
  void refreshAhInstances(true)
  if (cloud.on.value) void cloud.refresh()
}
/** One session to the account `ref` names (`label` in the notes), with no note or lock of its own: Move to account, one row or many. */
async function moveOne(sessionId: string, ref: string, label: string): Promise<MoveOutcome> {
  const codex = ref.startsWith('codex:')
  // The mover refuses a chat with an unfinished turn; this says so before any call.
  if (codex && src.external.value.some((s) => s.id === sessionId && codexBusy(s))) return { ok: false, error: 'it is still working in Codex. Let the turn finish, then move it.' }
  const before = src.external.value.find((s) => s.id === sessionId)
  try {
    const x: { ok: boolean; error?: string; sourceStillShown?: string[]; settingsInApp?: { ok: boolean; effort: string; ultracode: boolean; permissionMode: string | null; reason?: string }; stoppedCommands?: string[]; restored?: boolean; destinationThreadId?: string } = codex
      ? await moveCodexSession(sessionId, ref, { unassigned: !!before?.unassigned })
      : await moveSession(sessionId, ref)
    if (!x.ok) return { ok: false, error: x.error ?? 'AgentHydra did not say why' }
    const stopped = x.stoppedCommands?.length
      ? ` Archiving the original stopped ${x.stoppedCommands.length === 1 ? 'a command' : `${x.stoppedCommands.length} commands`} it still ran: ${x.stoppedCommands.map((c) => (c.length > 60 ? `${c.slice(0, 60)}…` : c)).join('; ')}.`
      : ''
    // Out of the holding area: it is on an account now.
    if (before?.unassigned) await src.updateSessionMeta(sessionId, { unassigned: false }).catch(() => {})
    // A Codex move makes a new chat (a new id): the note goes with it.
    if (before?.note && x.destinationThreadId) await src.updateSessionMeta(x.destinationThreadId, { note: before.note }).catch(() => {})
    const missed = settingsMissed(x)
    const note = x.restored
      ? `Back on ${label}.${missed}`
      : x.sourceStillShown?.length
        ? `Moved to ${label}. An old account still lists it.${missed}`
        : `Moved to ${label}. It is in that ${codex ? 'Codex' : 'desktop'} app now.${stopped}${missed}`
    return { ok: true, note, forMs: stopped || missed ? 15000 : 8000 }
  } catch (err) {
    return { ok: false, error: reasonOf(err) }
  }
}
async function moveToAccount(sessionId: string, title: string, item: RowMenuItem) {
  if (!item.value) return
  if (moving.value) {
    rowError.value = BUSY_MOVE
    return
  }
  moving.value = true
  rowError.value = null
  noteRow(`Moving “${title}” to ${item.label}…`)
  try {
    const x = await moveOne(sessionId, item.value, item.label)
    if (x.ok) noteRow(x.note, x.forMs)
    else {
      noteRow(null)
      rowError.value = `Move failed: ${x.error}`
    }
  } finally {
    settleMove()
  }
}

/**
 * Move to account, Unassigned or Duplicate to account on the picked rows (bulkMenu): one at a time, as AgentHydra takes
 * them, the list saying which one it is on; then how many went, and each that did not with its reason.
 */
async function moveEach(jobs: { title: string; run: () => Promise<MoveOutcome> }[], doing: (n: number, of: number) => string, done: (n: number, of: number) => string) {
  if (!jobs.length) return
  if (moving.value) {
    rowError.value = BUSY_MOVE
    return
  }
  moving.value = true
  rowError.value = null
  const failed: string[] = []
  try {
    for (const [i, job] of jobs.entries()) {
      noteRow(doing(i + 1, jobs.length))
      const x = await job.run()
      if (!x.ok) failed.push(`“${job.title}”: ${x.error}`)
    }
  } finally {
    settleMove()
  }
  const went = jobs.length - failed.length
  noteRow(went ? done(went, jobs.length) : null, 8000)
  if (failed.length) rowError.value = `${failed.length} of ${jobs.length} failed. ${failed.join('; ')}`
}

/**
 * Move to account > Unassigned (owner, 2026-10-13: "it's not assigned to an account, but it's not archived"): marked
 * first, so the list keeps it however old, then archived in its account's app, as a move retires its old copy. A refusal
 * takes the mark back. It waits in the Unassigned group until Move to account lands it on an account.
 */
/** One session off its account, with no note or lock of its own: Unassigned, one row or many. */
async function unassignOne(s: ExternalSession, state: RowState): Promise<MoveOutcome> {
  // Archiving a Codex chat would stop its turn, so AgentHydra refuses it; this says so before any call.
  if (codexBusy(s)) return { ok: false, error: 'it is still working in Codex. Let the turn finish first.' }
  const num = accountNum(state.account, accountChoices.value)
  const ref = num != null ? (accountChoices.value?.find((a) => a.num === num)?.ref ?? null) : null
  const failed = async (why: string): Promise<MoveOutcome> => {
    await src.updateSessionMeta(s.id, { unassigned: false }).catch(() => {})
    return { ok: false, error: why }
  }
  try {
    await src.updateSessionMeta(s.id, { unassigned: true, archived: false })
    const x = s.source === 'codex' ? await unassignCodexSession(s.id) : await unassignSession(s.id, ref)
    if (!x.ok) return await failed(x.error)
    return { ok: true, note: x.stillShown ? 'Unassigned. Its old account’s app shows it until that app restarts.' : 'Unassigned. It waits there until you move it to an account.', forMs: 8000 }
  } catch (err) {
    return await failed(reasonOf(err))
  }
}
async function unassign(s: ExternalSession, state: RowState) {
  if (moving.value) {
    rowError.value = BUSY_MOVE
    return
  }
  moving.value = true
  rowError.value = null
  noteRow(`Taking “${s.title}” off its account…`)
  try {
    const x = await unassignOne(s, state)
    if (x.ok) noteRow(x.note, x.forMs)
    else {
      noteRow(null)
      rowError.value = `Unassign failed: ${x.error}`
    }
  } finally {
    settleMove()
  }
}

/**
 * Duplicate to account (owner, 2026-10-13): a second chat with the whole conversation, landed on the account picked; the
 * original stays where it is. A copy that could not land waits in Unassigned, so it is never lost on no account.
 */
/** One copy of a session on the account `ref` names (`label` in the notes), with no note or lock of its own: Duplicate to account, one row or many. */
async function duplicateOne(sessionId: string, ref: string, label: string): Promise<MoveOutcome> {
  const codex = ref.startsWith('codex:')
  const s = src.external.value.find((r) => r.id === sessionId)
  if (codex && s && codexBusy(s)) return { ok: false, error: 'it is still working in Codex. Let the turn finish, then duplicate it.' }
  try {
    if (codex) {
      // AgentHydra's Codex move with the original kept: the copy is a new chat on that account. Codex gives it the
      // original's name, so the list names it "<title> (copy)", as a desktop copy is named: two rows of one name read as
      // a move that went wrong (owner, 2026-10-14: "two of the same named chat ... for no reason").
      const x = await moveCodexSession(sessionId, ref, { keepSource: true, unassigned: !!s?.unassigned })
      if (!x.ok) return { ok: false, error: x.error ?? 'AgentHydra did not say why' }
      const title = copyTitle(s?.title)
      const named = x.destinationThreadId ? await src.updateSessionMeta(x.destinationThreadId, { title }).then(() => true, () => false) : false
      return named
        ? { ok: true, note: `Duplicated to ${label} as “${title}”. It is in that Codex app now.`, forMs: 8000 }
        : { ok: true, note: `Duplicated to ${label} under the original’s name. It is in that Codex app now.`, forMs: 15000 }
    }
    const x = await duplicateSession(sessionId, ref)
    if (x.ok) return { ok: true, note: `Duplicated to ${label} as “${x.title}”.`, forMs: 8000 }
    if (x.copyId) await src.updateSessionMeta(x.copyId, { unassigned: true }).catch(() => {})
    return { ok: false, error: `${x.error ?? 'AgentHydra did not say why'}${x.copyId ? ' The copy waits in Unassigned.' : ''}` }
  } catch (err) {
    return { ok: false, error: reasonOf(err) }
  }
}
async function duplicate(sessionId: string, title: string, item: RowMenuItem) {
  if (!item.value) return
  if (moving.value) {
    rowError.value = BUSY_MOVE
    return
  }
  moving.value = true
  rowError.value = null
  noteRow(`Duplicating “${title}” to ${item.label}…`)
  try {
    const x = await duplicateOne(sessionId, item.value, item.label)
    if (x.ok) noteRow(x.note, x.forMs)
    else {
      noteRow(null)
      rowError.value = `Duplicate failed: ${x.error}`
    }
  } finally {
    settleMove()
  }
}

// Add note… / Edit note…: the person's own words on a chat, shown as a mark on its row and in its tooltip.
const noting = ref<Row | null>(null)
const noteDraft = ref('')
const noteHad = ref(false)
function openNote(row: Row) {
  const had = stateOf(row).note ?? ''
  noteDraft.value = had
  noteHad.value = had !== ''
  noting.value = row
}
function saveNote(text: string) {
  const row = noting.value
  noting.value = null
  if (row) mark(row, { note: text.trim() || null })
}
function onNoteKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    saveNote(noteDraft.value)
  }
}

// A session opened from a search (a click, or Enter) shows its folded header for a moment: its id and account are
// seen without unfolding it (session-header/state.ts peekHeader). Read at the moment of the change, before anything
// the opening sets off clears the search.
const searching = () => (cloud.on.value ? cloud.search.value.trim() !== '' : searchOpen.value && query.value.trim() !== '')
watch(
  selected,
  (now, before) => {
    if (now.kind === 'external' && (before?.kind !== 'external' || before.id !== now.id) && searching()) peekHeader()
  },
  { flush: 'sync' }
)
/** The desk row a session is, when the desk list shows it: a chat of ours by its session, else an outside session. */
function deskRowOf(id: string): Row | null {
  const chat = src.chats.value.find((c) => c.sessionId === id)
  if (chat) return { kind: 'chat', chat }
  const session = src.external.value.find((s) => s.id === id && s.source !== 'climayte')
  return session ? { kind: 'external', session } : null
}
/** An added row's menu: Open, and Copy session ID when it has one; none of a session's marks, which it is not. */
function addedMenu(a: AddedRow): RowMenuEntry[] {
  const out: RowMenuEntry[] = [{ action: 'open', label: 'Open' }]
  if (a.sessionId) out.push({ action: 'copySessionId', label: 'Copy session ID' })
  return out
}
function addedAct(a: AddedRow, item: RowMenuItem) {
  if (item.action === 'open') openAdded(a)
  else if (item.action === 'copySessionId' && a.sessionId) attempt('Copy', navigator.clipboard.writeText(a.sessionId))
}
/** A cloud row's menu: its desk row's (without Rename, which the row does inline), or Open, Pin and Copy session ID for one only the cloud list has. */
function cloudMenu(r: CloudSession): RowMenuEntry[] {
  const added = addedRows.value.get(r.id)
  if (added) return addedMenu(added)
  const row = deskRowOf(r.id)
  if (!row) {
    const account = r.instanceNum !== null ? { num: r.instanceNum, title: null } : null
    const accounts = r.source === 'codex' ? codexAccountChoices.value : accountChoices.value
    const out: RowMenuEntry[] = [
      rowIdentity(r.id, account, accounts),
      lastActionLine(r.lastActivityAt),
      'separator',
      { action: 'open', label: 'Open' },
      'separator',
      { action: 'pin', label: 'Pin', shortcut: 'P' },
      { action: 'copySessionId', label: 'Copy session ID' }
    ]
    const kind = cloudMovable(r)
    if (kind) out.push('separator', accountMenu(r.instanceNum, accounts, kind))
    return out
  }
  return rowMenu(stateOf(row), groupNames.value, accountChoices.value, codexAccountChoices.value, chatServices.value).filter((e) => e === 'separator' || !('action' in e) || e.action !== 'rename')
}
/** A Claude or Codex session on this PC only the cloud list has (a past one): AgentHydra here can move it, not one of the other PC's. */
function cloudMovable(r: CloudSession): 'desktop' | 'codex' | null {
  if (r.fromPc && r.fromPc !== cloud.thisPc.value) return null
  return r.source === 'claude' ? 'desktop' : r.source === 'codex' ? 'codex' : null
}
function cloudAct(r: CloudSession, item: RowMenuItem) {
  const added = addedRows.value.get(r.id)
  if (added) return addedAct(added, item)
  const row = deskRowOf(r.id)
  if (row) return item.action === 'open' ? openCloud(r) : act(row, item)
  if (item.action === 'open') openCloud(r)
  else if (item.action === 'pin') attempt('The change', src.updateSessionMeta(r.id, { pinned: true }))
  else if (item.action === 'copySessionId') attempt('Copy', navigator.clipboard.writeText(r.id))
  else if (item.action === 'copyId' && item.value) attempt('Copy', navigator.clipboard.writeText(item.value))
  else if (item.action === 'moveToAccount' && cloudMovable(r)) void moveToAccount(r.id, r.title, item)
}
/** Opening an outside session reads it, as opening a chat does. */
function openExternal(s: ExternalSession) {
  src.select({ kind: 'external', id: s.id })
  if (s.unread) mark({ kind: 'external', session: s }, { unread: false })
}
/** A desk-list row of an outside session: an added one (tasks.ts addedEntry) opens and acts as what it stands for, any other as its session. */
function selectExternal(s: ExternalSession) {
  const added = addedRows.value.get(s.id)
  if (added) openAdded(added)
  else openExternal(s)
}
function externalAct(s: ExternalSession, item: RowMenuItem) {
  const added = addedRows.value.get(s.id)
  const other = remoteRows.value.get(s.id)
  if (added) addedAct(added, item)
  else if (other) cloudAct(other, item)
  else act({ kind: 'external', session: s }, item)
}
function renameExternal(s: ExternalSession, title: string | null) {
  if (!isAddedRow(s.id)) attempt('The change', src.updateSessionMeta(s.id, { title }))
}
/** An added row's menu in place of an outside session's, the cloud list's for another PC's the cloud added; undefined for any other row. */
function externalMenu(id: string): RowMenuEntry[] | undefined {
  const added = addedRows.value.get(id)
  if (added) return addedMenu(added)
  const other = remoteRows.value.get(id)
  return other ? cloudMenu(other) : undefined
}

// Move to group > New group…: a name, then the row (or every picked row) moves there.
const naming = ref<Row[] | null>(null)
const groupDraft = ref('')
const GROUP_MAX = 60
const groupName = computed(() => groupDraft.value.trim())
function confirmGroup() {
  const rows = naming.value
  naming.value = null
  if (!rows || !groupName.value || groupName.value.length > GROUP_MAX) return
  for (const row of rows) mark(row, { group: moveTarget(stateOf(row), groupName.value) })
}
function confirmDelete() {
  const chats = deleting.value
  deleting.value = null
  if (!chats) return
  if (chats.some((c) => c.id === selectedChatId.value)) src.select({ kind: 'new' })
  for (const chat of chats) attempt('Delete', src.removeChat(chat.id))
}

// Rows picked together: Ctrl (Cmd) or Shift and a click (picked.ts; owner, 2026-10-14: "multi-select so I can right-click
// and transfer or do potentially more relevant actions with the right-click menu"). Two or more picked, a right-click or
// the three dots on any of them opens one menu for all (bulkMenu); a plain click, Escape or a right-click on a row not
// picked leaves them. A row added for running work and another PC's row the cloud added are not sessions of this list,
// so they are never picked. The picks are only rows drawn: a filter, a search, a fold or an archive takes rows out.
const picks = ref<Picks>(NO_PICKS)
const pickable = (e: SidebarEntry) => e.kind === 'chat' || (!isAddedRow(e.id) && !remoteRows.value.has(e.id))
const pickOrder = computed(() =>
  [...new Set(drawnList.value.flatMap((g) => (compactSidebar.value || !collapsed.value.has(g.key) ? g.entries.filter(pickable).map(entryKey) : [])))]
)
watch(pickOrder, (order) => (picks.value = prunePicks(picks.value, order)))
const openKey = computed(() => (selectedChatId.value ? `chat:${selectedChatId.value}` : selectedExternalId.value ? `external:${selectedExternalId.value}` : null))
/** A row's picked look: null while none is picked, so the open row shows as it always has. */
const pickedOf = (e: SidebarEntry): boolean | null => (picks.value.keys.size ? picks.value.keys.has(entryKey(e)) : null)
/** The picked rows as drawn, top to bottom; none until two are picked (one picked row's menu is its own). */
const pickedRows = computed<Row[]>(() => {
  const keys = picks.value.keys
  if (keys.size < 2) return []
  const out = new Map<string, Row>()
  for (const e of drawnList.value.flatMap((g) => g.entries))
    if (keys.has(entryKey(e)) && !out.has(entryKey(e))) out.set(entryKey(e), e.kind === 'chat' ? { kind: 'chat', chat: e.chat } : { kind: 'external', session: e.session })
  return [...out.values()]
})
const bulkEntries = computed(() => (pickedRows.value.length >= 2 ? bulkMenu(pickedRows.value.map(stateOf), groupNames.value, accountChoices.value, codexAccountChoices.value) : null))
/** The menu a picked row shows while two or more are picked; undefined for any other row (its own menu). */
const bulkMenuOf = (e: SidebarEntry): RowMenuEntry[] | undefined => (bulkEntries.value && picks.value.keys.has(entryKey(e)) ? bulkEntries.value : undefined)
/** A row's click or Enter: with Ctrl or Shift it picks rows; otherwise it leaves the picks and opens the row. */
function clickRow(entry: SidebarEntry, e: MouseEvent | KeyboardEvent, open: () => void) {
  const next = pickClick(picks.value, entryKey(entry), { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey }, pickOrder.value, openKey.value)
  if (next) {
    picks.value = next
    return
  }
  picks.value = { keys: new Set(), anchor: entryKey(entry) }
  open()
}
/** A right-click on a row not picked is for that row alone, as in Explorer: the picks go. */
function contextRow(entry: SidebarEntry) {
  if (picks.value.keys.size && !picks.value.keys.has(entryKey(entry))) picks.value = NO_PICKS
}
function clearPicks(e: KeyboardEvent) {
  if (!picks.value.keys.size || e.defaultPrevented) return
  picks.value = NO_PICKS
}
/** A row's menu item: on every picked row when its menu was the picked rows' (bulkMenuOf), else on the row alone. */
function rowAction(entry: SidebarEntry, item: RowMenuItem, own: () => void) {
  if (bulkMenuOf(entry)) bulkAct(pickedRows.value, item)
  else own()
}
const titleOf = (row: Row) => (row.kind === 'chat' ? row.chat.title : row.session.title)
/**
 * The picked rows a Move to account or Duplicate to account item can take: those that move to that kind of account,
 * a move leaving out each already on it and a Codex copy each whose original is on it (the mover copies between two homes).
 */
function headedTo(rows: Row[], item: RowMenuItem, copy: boolean) {
  const codex = !!item.value?.startsWith('codex:')
  const accounts = (codex ? codexAccountChoices : accountChoices).value
  const target = accounts?.find((a) => a.ref === item.value)?.num ?? null
  return rows.flatMap((row) => {
    const state = stateOf(row)
    if (state.movable !== (codex ? 'codex' : 'desktop')) return []
    const on = target !== null && accountNum(state.account, accounts) === target
    return (copy ? codex && on : on && !state.unassigned) ? [] : [{ row, state }]
  })
}
/** A bulkMenu item, run on every picked row it fits: a mark on each, the account moves one after another. */
function bulkAct(rows: Row[], item: RowMenuItem) {
  const ref = item.value
  if (item.action === 'moveToAccount' && ref)
    void moveEach(
      headedTo(rows, item, false).map(({ row, state }) => ({ title: titleOf(row), run: () => moveOne(state.id, ref, item.label) })),
      (n, of) => `Moving ${n} of ${of} to ${item.label}…`,
      (n, of) => `Moved ${n} of ${of} to ${item.label}.`
    )
  else if (item.action === 'duplicateToAccount' && ref)
    void moveEach(
      headedTo(rows, item, true).map(({ row, state }) => ({ title: titleOf(row), run: () => duplicateOne(state.id, ref, item.label) })),
      (n, of) => `Duplicating ${n} of ${of} to ${item.label}…`,
      (n, of) => `Duplicated ${n} of ${of} to ${item.label}.`
    )
  else if (item.action === 'unassign')
    void moveEach(
      rows.flatMap((row) => {
        const state = stateOf(row)
        return row.kind === 'external' && state.movable && !state.unassigned ? [{ title: titleOf(row), run: () => unassignOne(row.session, state) }] : []
      }),
      (n, of) => `Taking ${n} of ${of} off their accounts…`,
      (n, of) => `Unassigned ${n} of ${of}. They wait there until you move them to an account.`
    )
  else if (item.action === 'delete') {
    const chats = rows.flatMap((row) => (row.kind === 'chat' ? [row.chat] : []))
    if (chats.length) deleting.value = chats
  } else if (item.action === 'newGroup') {
    groupDraft.value = ''
    naming.value = rows
  } else if (item.action === 'copySessionId') {
    const ids = rows.flatMap((row) => stateOf(row).sessionId ?? [])
    if (ids.length) attempt('Copy', navigator.clipboard.writeText(ids.join('\n')))
  } else if (item.action === 'stop') {
    // Offered while any picked row runs a turn: only those are stopped.
    for (const row of rows) if (stateOf(row).stoppable) act(row, item)
  } else for (const row of rows) act(row, item)
}

// Footer
const face = computed(() => accountFace(src.settings.value?.defaultAccountId ?? 'auto', src.accounts.value))

const paneApi = usePaneApi()
const updateRow = computed(() =>
  footerUpdate({
    release: releaseWaiting.value,
    server: updateOffer.value,
    applying: releaseApplying.value,
    applyError: releaseApplyError.value,
    clicking: updateClicking.value,
  })
)
async function clickUpdateRow() {
  const row = updateRow.value
  if (!row?.clickable) return
  await clickUpdate(row.steps, {
    remember: rememberForUpdate,
    apply: () => applyWaitingRelease(paneApi),
    restartIfStale: async () => {
      await checkServerUpdate()
      if (updateOffer.value?.restartable) await restartServer()
    },
  })
}

// Resize handle
const root = ref<HTMLElement | null>(null)
function onResizeDown(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const rect = root.value?.getBoundingClientRect()
  const width = (x: number) => (props.side === 'right' ? (rect?.right ?? 0) - x : x - (rect?.left ?? 0))
  const move = (ev: PointerEvent) => emit('resize', clampSidebarWidth(width(ev.clientX)))
  const up = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
}
function onResizeKey(e: KeyboardEvent) {
  const outward = props.side === 'right' ? 'ArrowLeft' : 'ArrowRight'
  const inward = props.side === 'right' ? 'ArrowRight' : 'ArrowLeft'
  if (e.key === inward) emit('resize', clampSidebarWidth(props.width - 8))
  else if (e.key === outward) emit('resize', clampSidebarWidth(props.width + 8))
}

// The grip: dragged horizontally to the other half of the window, it previews the edge the sidebar would land on;
// released there it moves the sidebar, released on its own half, after a click, or on Escape it does nothing.
const GRIP_SLOP = 4
function onGripDown(e: PointerEvent) {
  if (e.button !== 0) return
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const startX = e.clientX
  let moved = false
  let over = dropSide(e.clientX, window.innerWidth)
  const show = () => emit('side-preview', over !== props.side ? over : null)
  const move = (ev: PointerEvent) => {
    if (Math.abs(ev.clientX - startX) > GRIP_SLOP) moved = true
    over = dropSide(ev.clientX, window.innerWidth)
    show()
  }
  const end = (commit: boolean) => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', cancel)
    window.removeEventListener('keydown', key)
    emit('side-preview', null)
    if (commit && moved && over !== props.side) emit('side', over)
  }
  const up = () => end(true)
  const cancel = () => end(false)
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return
    ev.preventDefault()
    end(false)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', key)
}

defineExpose({
  openSearch,
  /** The title bar's chat menu runs here: the same actions and dialogs as the row's. */
  chatAction: (chat: ChatSummary, item: RowMenuItem) => act({ kind: 'chat', chat }, item),
  /** The title bar's rename: a failure shows in the same alert as a row's. */
  renameChat: (chat: ChatSummary, title: string) => mark({ kind: 'chat', chat }, { title })
})

const NAV_ROW =
  'group/nav flex h-[26px] w-full cursor-default items-center gap-1 rounded-[var(--radius-6)] px-0.5 text-start text-ui leading-[19.5px] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-snap)] select-none'
const HEADER_BTN = 'flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-6)] text-text-2 hover:bg-fill-hover hover:text-text'
</script>

<template>
  <aside
    ref="root"
    aria-label="Sidebar"
    class="relative flex h-full shrink-0 flex-col bg-bg-sidebar pt-9"
    :class="side === 'right' ? 'border-s border-border' : 'border-e border-border'"
    :style="fill ? undefined : { width: `${width}px` }"
  >
    <!-- The shade along its inner edge, just inside the line, as Claude Desktop's sidebar has (owner, 2026-10-08: "kind
         of a inner shadow. That has a little bit of a spread"; then "a little too dark", so 20% black, not 30). Over the
         rows, under every menu, never in the way of a click. -->
    <span
      class="pointer-events-none absolute inset-y-0 z-10 w-4 from-black/20 to-transparent"
      :class="side === 'right' ? 'left-0 bg-linear-to-r' : 'right-0 bg-linear-to-l'"
      aria-hidden="true"
    />
    <div class="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-1 pt-2">
      <nav class="flex shrink-0 flex-col gap-[0.5px] pe-0.5">
        <div class="flex items-center gap-0.5">
          <button
            type="button"
            :class="[NAV_ROW, 'min-w-0 flex-1', selected.kind === 'new' ? 'bg-fill-hover text-text' : 'bg-fill-5 text-text hover:bg-fill-hover']"
            @click="src.select({ kind: 'new' })"
          >
            <span class="flex size-6 shrink-0 items-center justify-center text-text-2">
              <span class="flex size-4.5 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--text-2)_15%,transparent)]">
                <component :is="shellGlyphs.newPlus" class="size-4" />
              </span>
            </span>
            <span class="min-w-0 flex-1 truncate">New</span>
            <kbd class="pe-1.5 font-sans text-ui-sm text-text-shortcut opacity-0 group-hover/nav:opacity-100">Ctrl + N</kbd>
          </button>
          <!-- The Search and Filter buttons (SidebarTools.vue) sit beside New, over the desk list and the cloud list alike. -->
          <SidebarTools v-if="!hydraModel && !devServers.on.value" :search-open="searchOpen" :filter="filter" @search="searchOpen ? closeSearch() : openSearch()" @update:filter="(f: SidebarFilter) => (filter = f)" />
          <Tip v-if="fill" label="Expand AgentHydra">
            <button type="button" :class="HEADER_BTN" aria-label="Expand AgentHydra" @click="emit('expand')">
              <component :is="PanelRightOpen" class="size-4" />
            </button>
          </Tip>
          <Tip v-else-if="collapsible" label="Collapse to the edge of the screen">
            <button type="button" :class="HEADER_BTN" aria-label="Collapse to the edge of the screen" @click="emit('collapse')">
              <component :is="PanelRightClose" class="size-4" />
            </button>
          </Tip>
        </div>
      </nav>

      <!-- The grip sits in the gap under New: its negative margins keep the list where it was, and it stacks over the list's empty top padding. -->
      <Tip v-if="!fill" label="Drag to move the sidebar to the other side">
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Drag to move the sidebar to the other side"
          class="group/grip relative z-10 -mb-3 -mt-2 flex h-3 shrink-0 cursor-grab touch-none select-none items-center justify-center active:cursor-grabbing"
          @pointerdown.prevent="onGripDown"
        >
          <span class="flex gap-0.5 opacity-0 transition-opacity duration-150 group-hover/grip:opacity-100" aria-hidden="true">
            <span v-for="n in 6" :key="n" class="size-0.75 rounded-full bg-text-muted" />
          </span>
        </div>
      </Tip>

      <!-- Sessions: Pinned, then one group per folder; ours and the ones running elsewhere together -->
      <div class="min-h-0 flex-1 overflow-y-auto pe-0.5 pt-1 [scrollbar-width:none]" @keydown.escape="clearPicks">
        <div v-if="searchOpen && !hydraModel && !devServers.on.value" class="mb-1 flex h-6.5 items-center gap-1 rounded-(--radius-6) bg-fill-5 px-0.5">
          <span class="flex size-6 shrink-0 items-center justify-center text-text-muted"><component :is="icons.search" class="size-4" /></span>
          <input
            ref="searchInput"
            v-model="searchText"
            type="text"
            aria-label="Search sessions"
            :placeholder="cloud.on.value ? 'Search every session' : 'Search sessions'"
            class="h-full min-w-0 flex-1 bg-transparent text-ui text-text outline-none placeholder:text-text-muted"
            @keydown="cloud.on.value ? onCloudSearchKey($event) : onSearchKey($event)"
          />
          <button type="button" aria-label="Close search" class="flex size-5 items-center justify-center rounded-(--radius-5) text-text-muted hover:bg-fill-hover hover:text-text" @click="closeSearch">
            <component :is="icons.dismiss" class="size-3.5" />
          </button>
        </div>

        <HydraSidebar v-if="hydraModel" :model="hydraModel" :stale="hydraShown?.stale" />

        <DevServersList v-else-if="devServers.on.value" />

        <CloudList v-else-if="cloudListShown" :groups="cloudGroups" :icon-of="iconOfGroup" :project-folder-of="projectFolderOf":selected-id="selectedCloudId" @new-session="(cwd: string) => src.select({ kind: 'new', cwd })" :tasks-of="nesting ? (id: string) => tasksOf(`cloud:${id}`) : undefined" :shown-of="nesting ? (id: string) => rowSub(`cloud:${id}`).nodes : undefined" :jobs-of="nesting ? (id: string) => jobsCounted(`cloud:${id}`) : undefined" :shown-jobs-of="nesting ? (id: string) => rowSub(`cloud:${id}`).jobs : undefined" :running="sessionRunning" :glyph="cloudDot" :pulse="cloudPulse" :menu-for="cloudMenu" @action="cloudAct" @open="openCloud" @open-task="openTask" @open-job="openJob">
          <template #sub-badges="{ id }">
            <SubBadges v-if="nesting" :row-key="`cloud:${id}`" :badges="rowSub(`cloud:${id}`).badges" />
          </template>
        </CloudList>

        <template v-else>
        <DefineGroupHead v-slot="{ group }">
          <Tip :label="group.cwd ?? ''" align="start">
            <button
              type="button"
              class="flex min-w-0 items-center gap-0.5 rounded-sm hover:text-text-2"
              :aria-expanded="!collapsed.has(group.key)"
              @click="toggleGroup(group.key)"
            >
              <img v-if="groupIcons.get(group.key)" :src="groupIcons.get(group.key)!" alt="" class="me-0.5 size-3.5 shrink-0 rounded-(--radius-4)" />
              <!-- No project icon: its first letter in a tile the icon's size (owner, 2026-10-15: "desktop would have, like, a
                   small D icon. Unassigned can just have no icon"). -->
              <span
                v-else-if="group.key !== UNASSIGNED && group.label.trim()"
                aria-hidden="true"
                class="me-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-(--radius-4) bg-(--fill-secondary) text-[9px] leading-none font-semibold text-text-2"
                data-testid="group-letter"
              >{{ group.label.trim().charAt(0).toUpperCase() }}</span>
              <span class="truncate">{{ group.label }}</span>
              <EyeOff v-if="group.hidden" role="img" aria-label="Hidden group" class="ms-0.5 size-3 shrink-0" />
              <component
                :is="shellGlyphs.groupChevron"
                class="size-3 shrink-0 transition-transform duration-(--dur-fast) group-hover/head:opacity-100"
                :class="collapsed.has(group.key) ? 'opacity-100' : 'rotate-90 opacity-0'"
              />
              <RunningBadge v-if="foldedRunning.get(group.key)" class="ms-1" :tasks="foldedRunning.get(group.key)!.tasks" :jobs="foldedRunning.get(group.key)!.jobs" :chats="foldedRunning.get(group.key)!.chats" />
            </button>
          </Tip>
          <span class="flex-1" />
          <GroupDashboardButton :folder="menuFolderOf(group)" :label="group.label" />
          <TodoButton :folder="menuFolderOf(group)" :label="group.label" />
          <Tip v-if="deskNewFolder(group)" :label="`New session in ${group.label}`">
            <button type="button" :class="HEADER_BTN" :aria-label="`New session in ${group.label}`" @click="src.select({ kind: 'new', cwd: deskNewFolder(group)! })">
              <component :is="shellGlyphs.groupNew" class="size-4" />
            </button>
          </Tip>
        </DefineGroupHead>
        <!-- A folder whose last row went away fades and folds shut like the row (row-leave.ts). -->
        <TransitionGroup :css="false" @leave="rowLeave">
        <!-- Compact sidebar (compact.ts): no group headers, so no heading to right-click, open or add to; the chats stay in their groups. -->
        <section v-for="group in drawnList" :key="group.key" :aria-label="group.label" :class="compactSidebar && group.hidden && 'opacity-60'">
          <!-- A group's right-click menu (ProjectMenuItems for a project folder's) can hide it (hidden.ts); Show hidden in the Filter menu brings it back, dimmed, with Unhide. -->
          <span v-if="!compactSidebar" class="block" v-on="groupMenus.listeners(group.key)">
          <ContextMenu v-if="groupMenus.seen(group.key)">
          <ContextMenuTrigger as-child :disabled="!hideable(group)">
          <header
            class="group/head flex h-8.5 items-center gap-0 pb-1 ps-1.5 pe-px pt-3 text-ui-sm leading-4 text-text-muted"
            :class="group.hidden && 'opacity-60'"
          >
            <ReuseGroupHead :group="group" />
          </header>
          </ContextMenuTrigger>
          <ContextMenuContent :class="MENU_CONTENT" @open-auto-focus="focusFirstItem">
            <!-- A project folder's group: its stats, Open project folder, Collapse, Auto-categorize on a scratch folder, and Hide (owner, 2026-10-10). -->
            <ProjectMenuItems
              v-if="menuFolderOf(group)"
              :folder="menuFolderOf(group)!"
              :label="group.label"
              :collapsed="collapsed.has(group.key)"
              :hidden="!!group.hidden"
              @toggle="toggleGroup(group.key)"
              @hide="hiddenGroups.hide(groupOrderKey(group), !group.hidden)"
            />
            <ContextMenuItem v-else :class="MENU_ITEM" :title="group.hidden ? undefined : HIDE_TITLE" @select="hiddenGroups.hide(groupOrderKey(group), !group.hidden)">
              <span class="flex-1">{{ group.hidden ? 'Unhide' : 'Hide' }}</span>
            </ContextMenuItem>
          </ContextMenuContent>
          </ContextMenu>
          <header
            v-else
            class="group/head flex h-8.5 items-center gap-0 pb-1 ps-1.5 pe-px pt-3 text-ui-sm leading-4 text-text-muted"
            :class="group.hidden && 'opacity-60'"
          >
            <ReuseGroupHead :group="group" />
          </header>
          </span>
          <!-- Compact sidebar shows a collapsed group's chats too: with no header there is no way to open it. -->
          <TransitionGroup v-if="compactSidebar || !collapsed.has(group.key)" tag="div" class="flex flex-col gap-[1.5px] pt-[1.5px]" :css="false" @leave="rowLeave">
            <div
              v-for="entry in group.entries"
              :key="`${entry.kind}:${src.rowKeyOf?.(entry.id) ?? entry.id}`"
              :data-search-cursor="cursorKey === `${entry.kind}:${entry.id}` || undefined"
              :class="[cursorKey === `${entry.kind}:${entry.id}` ? 'rounded-(--radius-6) bg-fill-hover' : '', entry.under && 'ms-2.75 border-s border-border ps-1', rowDrag.line(entry.id)]"
              :style="entry.under && entry.depth ? { marginInlineStart: `${entry.depth * 0.6875}rem` } : undefined"
              :draggable="rowsDraggable(group)"
              @dragstart="rowsDraggable(group) && rowDrag.start($event, group.key, entry.id)"
              @dragover="rowsDraggable(group) && rowDrag.onOver($event, group.key, entry.id)"
              @drop="rowsDraggable(group) && rowDrag.drop($event, group.key, group.entries.map((e) => e.id), entry.id)"
              @dragend="rowDrag.end"
              @contextmenu.capture="contextRow(entry)"
            >
              <ChatRow
                v-if="entry.kind === 'chat'"
                :chat="entry.chat"
                :selected="selectedChatId === entry.id"
                :picked="pickedOf(entry)"
                :entries="bulkMenuOf(entry)"
                :groups="groupNames"
                :compact="compactSidebar && !entry.under"
                :icon="groupIcons.get(group.key) ?? null"
                :dot="entryGlyph(entry)"
                @select="(e: MouseEvent | KeyboardEvent) => clickRow(entry, e, () => src.select({ kind: 'chat', id: entry.id }))"
                @action="(item: RowMenuItem) => rowAction(entry, item, () => act({ kind: 'chat', chat: entry.chat }, item))"
                @rename="(title: string) => mark({ kind: 'chat', chat: entry.chat }, { title })"
              >
                <FoldButton v-if="foldOf(`chat:${entry.id}`)" v-bind="foldOf(`chat:${entry.id}`)!" @toggle="toggleFolded(`chat:${entry.id}`)" />
                <SubBadges v-if="rowSub(`chat:${entry.id}`).badges.length" :row-key="`chat:${entry.id}`" :badges="rowSub(`chat:${entry.id}`).badges" />
              </ChatRow>
              <ExternalRow
                v-else
                :session="entry.session"
                :selected="selectedExternalId === entry.id"
                :picked="pickedOf(entry)"
                :groups="groupNames"
                :entries="bulkMenuOf(entry) ?? externalMenu(entry.id)"
                :dot="entryGlyph(entry)"
                :compact="compactSidebar && !entry.under"
                :icon="groupIcons.get(group.key) ?? null"
                @select="(e: MouseEvent | KeyboardEvent) => clickRow(entry, e, () => selectExternal(entry.session))"
                @action="(item: RowMenuItem) => rowAction(entry, item, () => externalAct(entry.session, item))"
                @rename="(title: string | null) => renameExternal(entry.session, title)"
              >
                <FoldButton v-if="foldOf(`external:${entry.id}`)" v-bind="foldOf(`external:${entry.id}`)!" @toggle="toggleFolded(`external:${entry.id}`)" />
                <SubBadges v-if="rowSub(`external:${entry.id}`).badges.length" :row-key="`external:${entry.id}`" :badges="rowSub(`external:${entry.id}`).badges" />
              </ExternalRow>
              <TaskRows v-if="rowSub(`${entry.kind}:${entry.id}`).nodes.length || rowSub(`${entry.kind}:${entry.id}`).jobs.length" :nodes="rowSub(`${entry.kind}:${entry.id}`).nodes" :jobs="rowSub(`${entry.kind}:${entry.id}`).jobs" :selected-id="selectedExternalId" @open="openTask" @open-job="openJob" />
            </div>
          </TransitionGroup>
        </section>
        </TransitionGroup>

        <div v-if="groupList.length === 0" class="flex items-center gap-1 px-1.5 pt-3 text-ui-sm leading-4 text-text-muted">
          <span class="flex-1">{{ emptyText }}</span>
          <template v-if="filtering && !searchOpen">
            <button type="button" class="rounded-sm px-1 text-text-2 hover:bg-fill-hover" @click="filter = 'active'">Show active</button>
            <button type="button" class="rounded-sm px-1 text-text-2 hover:bg-fill-hover" @click="showAll">Show all</button>
          </template>
          <button v-if="groups.hiddenOut" type="button" class="rounded-sm px-1 text-text-2 hover:bg-fill-hover" @click="hiddenGroups.setShowHidden(true)">Show hidden</button>
        </div>

        <p v-if="rowNote" role="status" class="px-1.5 pt-3 text-ui-sm leading-4 text-text-2">{{ rowNote }}</p>
        <p v-if="rowError" role="alert" class="flex items-start gap-1 px-1.5 pt-3 text-ui-sm leading-4 text-danger-text">
          <span class="min-w-0 flex-1">{{ rowError }}</span>
          <button type="button" aria-label="Dismiss" class="shrink-0 rounded-sm px-1 text-text-muted hover:bg-fill-hover hover:text-text" @click="rowError = null">
            <component :is="icons.dismiss" class="size-3" />
          </button>
        </p>

        <!-- AgentHydra's transcript search: sessions the query was said in, minus the rows above -->
        <section v-if="searchOpen && search.phase !== 'idle'" aria-label="Everywhere">
          <header class="flex h-8.5 items-center gap-1.5 pb-1 ps-1.5 pe-px pt-3 text-ui-sm leading-4 text-text-muted">
            <span>Everywhere</span>
            <!-- A gray pulsing dot, not a spinner: nothing in the sidebar spins (owner, 2026-10-05). -->
            <span
              v-if="search.phase === 'loading'"
              role="status"
              aria-label="Searching AgentHydra"
              class="size-1.5 rounded-full bg-current"
              :class="runPulse('gray')"
            />
          </header>
          <p v-if="search.phase === 'offline'" class="px-1.5 text-ui-sm leading-4 text-text-muted">AgentHydra search is offline</p>
          <Tip v-else-if="search.phase === 'failed'" :label="search.error ?? ''">
            <p class="truncate px-1.5 text-ui-sm leading-4 text-text-muted">
              AgentHydra search failed: {{ search.error }}
            </p>
          </Tip>
          <p v-else-if="search.phase === 'done' && everywhere.length === 0" class="px-1.5 text-ui-sm leading-4 text-text-muted">No matches</p>
          <div v-else class="flex flex-col gap-[1.5px] pt-[1.5px]">
            <SearchHitRow
              v-for="row in everywhere"
              :key="row.key"
              :hit="row.hit"
              :query="search.query"
              :active="cursorKey === row.key"
              :selected="row.view.kind === 'chat' ? selectedChatId === row.view.id : selectedExternalId === row.view.id"
              @select="src.select(row.view)"
            />
          </div>
        </section>
        </template>
        <!-- Only under the CloudList: with the cloud on but not selecting, the grouped list above draws these itself, and a
             second copy here showed every note twice (2026-10-13). -->
        <p v-if="cloudShown && rowNote" role="status" class="px-1.5 pt-3 text-ui-sm leading-4 text-text-2">{{ rowNote }}</p>
        <p v-if="cloudShown && rowError" role="alert" class="flex items-start gap-1 px-1.5 pt-3 text-ui-sm leading-4 text-danger-text">
          <span class="min-w-0 flex-1">{{ rowError }}</span>
          <button type="button" aria-label="Dismiss" class="shrink-0 rounded-sm px-1 text-text-muted hover:bg-fill-hover hover:text-text" @click="rowError = null">
            <component :is="icons.dismiss" class="size-3" />
          </button>
        </p>
      </div>
    </div>

    <!-- The update row sits above the footer while an update can be done (desk-update-row.ts) -->
    <div v-if="updateRow" class="shrink-0 px-2.5 py-2 ps-2">
      <Tip label="Your chats are saved and keep running while it restarts" side="top">
        <button
          type="button"
          :disabled="!updateRow.clickable"
          :aria-busy="updateRow.busy || undefined"
          class="flex h-8 w-full min-w-0 items-center gap-2 rounded-(--radius-6) border border-border ps-2.5 pe-2 text-start text-ui leading-[19.5px] text-text-2 transition-colors duration-60 hover:bg-fill-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent) disabled:cursor-default disabled:hover:bg-transparent"
          @click="clickUpdateRow"
        >
          <span class="size-1.5 shrink-0 rounded-full bg-accent" :class="updateRow.busy ? 'animate-pulse' : ''" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate">{{ updateRow.label }}</span>
          <ChevronRight v-if="updateRow.clickable" class="size-3 shrink-0 text-text-muted" aria-hidden="true" />
        </button>
      </Tip>
      <p v-if="updateRow.error" role="alert" class="px-1 pt-1.5 text-ui-sm leading-4 text-danger-text">{{ updateRow.error }}</p>
    </div>

    <!-- Footer: the profile pill opens the account popup above it; the gear opens Settings itself -->
    <footer class="flex h-11 shrink-0 items-center justify-between border-t border-border pb-px ps-2 pe-2.5">
      <AccountsPopover v-model:open="accountsOpen" @settings="src.openSettings()">
        <button
          type="button"
          :aria-label="`Account for new chats: ${face.name}`"
          class="flex h-7 min-w-0 cursor-default items-center gap-1.5 rounded-(--radius-6) ps-1 pe-1.5 transition-colors duration-60 hover:bg-fill-hover data-[state=open]:bg-fill-hover"
        >
          <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-(--fill-secondary) text-3xs font-semibold leading-none text-text">{{ face.initial }}</span>
          <!-- In a narrow sidebar the plan ("· 41 accounts") gives way before the name does. -->
          <span class="max-w-full shrink-0 truncate text-ui leading-[19.5px] text-text-2">{{ face.name }}</span>
          <span v-if="face.plan" class="min-w-0 truncate text-ui-sm leading-4 text-text-muted">· {{ face.plan }}</span>
          <component :is="icons.more" class="ms-2.5 size-3 shrink-0 text-text-muted" />
        </button>
      </AccountsPopover>
      <HeadlessAudioButton />
      <Tip :label="ahUpdateDot ? 'Settings: an AgentHydra update is waiting' : 'Settings'" side="top">
        <button
          type="button"
          aria-label="Settings"
          :aria-description="ahUpdateDot ? 'An AgentHydra update is waiting' : undefined"
          class="relative flex size-6 shrink-0 items-center justify-center rounded-(--radius-6) text-text-2 hover:bg-fill-hover hover:text-text"
          @click="src.openSettings()"
        >
          <component :is="sidebarIcons.footer" class="size-4" />
          <span v-if="ahUpdateDot" class="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-accent" aria-hidden="true" />
        </button>
      </Tip>
    </footer>

    <!-- Below the chrome bar while the bar reaches past a narrow sidebar, so it never takes its buttons' clicks. -->
    <div
      v-if="!fill"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      tabindex="0"
      :aria-valuenow="width"
      :aria-valuemin="SIDEBAR_MIN"
      :aria-valuemax="SIDEBAR_MAX"
      class="absolute bottom-0 z-22 w-3 cursor-col-resize touch-none"
      :class="[side === 'right' ? '-left-1.5' : '-right-1.5', width < CHROME_OPEN ? 'top-9' : 'top-0']"
      @pointerdown.prevent="onResizeDown"
      @keydown="onResizeKey"
    />

    <Dialog :open="deleting !== null" @update:open="(o: boolean) => !o && (deleting = null)">
      <DialogContent :show-close-button="false" class="gap-3 rounded-(--radius-12) p-4 shadow-(--shadow-popover) ring-0 sm:max-w-90">
        <DialogTitle class="text-ui-lg font-semibold leading-5 text-text">{{ (deleting?.length ?? 0) > 1 ? `Delete ${deleting!.length} sessions?` : 'Delete session?' }}</DialogTitle>
        <DialogDescription class="text-ui leading-4.75 text-text-2">
          {{ (deleting?.length ?? 0) > 1 ? `${deleting!.length} sessions` : `“${deleting?.[0]?.title ?? ''}”` }} will be removed from Hydra Desk. This cannot be undone.
        </DialogDescription>
        <div class="flex justify-end gap-2 pt-1">
          <button type="button" class="h-7 rounded-(--radius-6) bg-(--fill-secondary) px-3 text-ui text-text hover:bg-(--fill-secondary-hover)" @click="deleting = null">Cancel</button>
          <button type="button" class="h-7 rounded-(--radius-6) bg-danger px-3 text-ui font-medium text-white hover:brightness-110" @click="confirmDelete">Delete</button>
        </div>
      </DialogContent>
    </Dialog>

    <Dialog :open="naming !== null" @update:open="(o: boolean) => !o && (naming = null)">
      <DialogContent :show-close-button="false" class="gap-3 rounded-(--radius-12) p-4 shadow-(--shadow-popover) ring-0 sm:max-w-90">
        <DialogTitle class="text-ui-lg font-semibold leading-5 text-text">New group</DialogTitle>
        <DialogDescription class="sr-only">Name the group to move {{ (naming?.length ?? 0) > 1 ? 'these sessions' : 'this session' }} to.</DialogDescription>
        <form class="flex flex-col gap-3" @submit.prevent="confirmGroup">
          <Input v-model="groupDraft" aria-label="Group name" placeholder="Group name" :maxlength="GROUP_MAX" class="h-8 text-ui" />
          <div class="flex justify-end gap-2">
            <button type="button" class="h-7 rounded-(--radius-6) bg-(--fill-secondary) px-3 text-ui text-text hover:bg-(--fill-secondary-hover)" @click="naming = null">Cancel</button>
            <button
              type="submit"
              :disabled="!groupName"
              class="h-7 rounded-(--radius-6) bg-accent px-3 text-ui font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              Move
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog :open="noting !== null" @update:open="(o: boolean) => !o && (noting = null)">
      <DialogContent :show-close-button="false" class="gap-3 rounded-(--radius-12) p-4 shadow-(--shadow-popover) ring-0 sm:max-w-90">
        <DialogTitle class="text-ui-lg font-semibold leading-5 text-text">{{ noteHad ? 'Edit note' : 'Add note' }}</DialogTitle>
        <DialogDescription class="sr-only">A note on this chat, shown when you point at its row.</DialogDescription>
        <form class="flex flex-col gap-3" @submit.prevent="saveNote(noteDraft)">
          <textarea
            v-model="noteDraft"
            aria-label="Note"
            placeholder="Note"
            rows="4"
            :maxlength="NOTE_MAX"
            class="min-h-20 resize-y rounded-(--radius-6) border border-border bg-transparent px-2.5 py-1.5 text-ui leading-4.75 text-text outline-none placeholder:text-text-muted focus-visible:ring-2 focus-visible:ring-(--accent)"
            @keydown="onNoteKey"
          />
          <div class="flex items-center gap-2">
            <button v-if="noteHad" type="button" class="h-7 rounded-(--radius-6) px-2 text-ui text-danger-text hover:bg-fill-hover" @click="saveNote('')">Remove</button>
            <span class="flex-1" />
            <button type="button" class="h-7 rounded-(--radius-6) bg-(--fill-secondary) px-3 text-ui text-text hover:bg-(--fill-secondary-hover)" @click="noting = null">Cancel</button>
            <button type="submit" :disabled="!noteHad && !noteDraft.trim()" class="h-7 rounded-(--radius-6) bg-accent px-3 text-ui font-medium text-white hover:brightness-110 disabled:opacity-50">Save</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
    <AutoCategorizeDialog />
  </aside>
</template>
