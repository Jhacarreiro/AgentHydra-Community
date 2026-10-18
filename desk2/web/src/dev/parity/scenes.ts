// The parity page's scenes: which fixture state each '#/parity/<scene>' renders. The scene list with the
// reference images, crops and viewports is docs/reference/real/scenes.json; its routes point here.
import { ref } from 'vue'
import type { Dashboard } from '@shared/dashboards'
import type { AccountInfo, ChatSummary, CliMayteWorker, DeskSettings, ExternalSession, GitStatus, TranscriptIndex, TranscriptItem } from '@shared/protocol'
import { FREE_SETTINGS_DEFAULTS } from '@shared/free-instances'
import { buildTranscriptIndex } from '@shared/transcript-index'
import type { HeadlessAudioState } from '@shared/headless-audio'
import { routinesFixtures, cliMayteWorkerFixtures, settingsFixtures } from '@/dev/fixtures'
import { routineDetailsFixture } from '@/dev/routine-details-fixture'
import type { ShellSource } from '@/components/shell/source'
import type { View } from '@/components/shell/logic'
import type { ComposerApi } from '@/components/composer/api'
import type { PaneApi } from '@/components/panes/api'
import { SIDEBAR_MIN } from '@/components/sidebar/width'
import { PARITY_NOW } from './clock'
import { dashboardFixture, emptyDashboardFixture } from './dashboard'
import { backgroundTaskWorkers } from './tasks'
import { markdownSceneItems } from './markdown'
import {
  CWD,
  HARVEST_DRAFT,
  HARVEST_GIT,
  WINDOW_DRAFT,
  WINDOW_GIT,
  harvestChats,
  harvestItems,
  managerChats,
  parityAccounts,
  popoverAccounts,
  sidebarUserChats,
  windowChats,
  windowItems
} from './fixtures'

export type MenuName = 'plus' | 'mode' | 'model' | 'effort'

export interface ParityScene {
  /** The whole DeskFrame (the composer-alone 'dock' layout went with the composer's agents chip, 2026-10-05). */
  layout: 'frame'
  chats: () => ChatSummary[]
  items: () => TranscriptItem[]
  view: View
  git: { branch: string; added: number; removed: number }
  /** The grey suggested next prompt the real captures show in the empty box (not a typed draft). */
  suggestion?: string
  external?: ExternalSession[]
  accountsOpen?: boolean
  /** The account list (default: the two of the composer captures) and the saved default account. */
  accounts?: () => AccountInfo[]
  defaultAccountId?: string
  /** The account Auto would pick now. */
  pickId?: string
  openDiff?: boolean
  /** The CliMayte workers the store lists (default: the gallery's three). */
  workers?: () => CliMayteWorker[]
  /** Opens the Background tasks panel. */
  openTasks?: boolean
  /** Views visited before `view` (the window capture has Back enabled). */
  history?: View[]
  /** A failed action's message, shown in the title bar (the app's action-error ref). */
  alert?: string
  /** Opens the project dashboard page over the chat; its reads answer with this dashboard. */
  dashboard?: () => Dashboard
  /** The sidebar starts hidden, so the title bar spans the window. */
  sidebarHidden?: boolean
  /** The width the sidebar was dragged to (the page sets its saved width; default SIDEBAR_DEFAULT). */
  sidebarWidth?: number
  /** The headless Chrome audio the Desk has (applied before the first render, as the server's fetch would). */
  audio?: HeadlessAudioState
  /** Only the newest this many items start loaded; the rest are served a page of 200 at a time as the transcript asks (loadOlder). */
  windowed?: number
}

const whole: ParityScene = {
  layout: 'frame',
  chats: harvestChats,
  items: harvestItems,
  view: { kind: 'chat', id: 'ccd' },
  git: HARVEST_GIT,
  suggestion: HARVEST_DRAFT,
  history: [{ kind: 'chat', id: 'pc' }]
}

const headerFit: ParityScene = {
  ...whole,
  chats: () =>
    harvestChats().map((c) =>
      c.id === 'ccd'
        ? { ...c, title: 'Northwind regional rollout planning and vendor review notes', cwd: 'C:/Users/me/code/northwind-rollout-planning-workspace', status: 'working', turnStartedAt: PARITY_NOW - 31 * 60_000, climayteActive: 2 }
        : c
    )
}

// One chat makes sound, one chat is muted, and a headless page no chat owns makes sound: the speakers and the footer's one speaker.
const headlessAudio: ParityScene = {
  layout: 'frame',
  chats: windowChats,
  items: windowItems,
  view: { kind: 'chat', id: 'ccd' },
  git: WINDOW_GIT,
  suggestion: WINDOW_DRAFT,
  audio: {
    audible: ['nvw'],
    muted: ['cfn'],
    unattributed: [{ profile: 'C:/Users/me/AppData/Local/HydraDesk2/headless/Work', url: 'https://example.test/player' }],
    unattributedMuted: false
  }
}

/** 1,000 invented items (500 questions and answers of varied length) for the lazy-loading transcript: ids lazy-0 ... lazy-999. */
function lazyItems(): TranscriptItem[] {
  const out: TranscriptItem[] = []
  for (let i = 0; i < 500; i++) {
    const ts = PARITY_NOW - (500 - i) * 60_000
    out.push({ id: `lazy-${2 * i}`, ts, kind: 'user', text: `Question ${i}: how does the sample ledger handle batch ${i}?` })
    out.push({
      id: `lazy-${2 * i + 1}`,
      ts: ts + 1000,
      kind: 'assistant_text',
      text: `Batch ${i} is posted once and then checked. `.repeat(1 + ((i * 7) % 11))
    })
  }
  return out
}

// Lazy loading: 1,000 items, the newest 200 loaded, the rest a page of 200 at a time as the transcript is scrolled up.
const lazy: ParityScene = { ...whole, items: lazyItems, windowed: 200 }

export const PARITY_SCENES: Record<string, ParityScene> = {
  dashboard: { ...whole, dashboard: dashboardFixture },
  'dashboard-empty': { ...whole, dashboard: emptyDashboardFixture },
  window: { layout: 'frame', chats: windowChats, items: windowItems, view: { kind: 'chat', id: 'ccd' }, git: WINDOW_GIT, suggestion: WINDOW_DRAFT, history: [{ kind: 'chat', id: 'avg' }] },
  'sidebar-user': { layout: 'frame', chats: sidebarUserChats, items: windowItems, view: { kind: 'chat', id: 'ccd' }, git: WINDOW_GIT, suggestion: WINDOW_DRAFT },
  // Rows on managers, with a photo and with an initial, for e2e/manager-avatar.e2e.ts.
  'manager-avatar': { layout: 'frame', chats: managerChats, items: windowItems, view: { kind: 'chat', id: 'ccd' }, git: WINDOW_GIT, suggestion: WINDOW_DRAFT },
  'headless-audio': headlessAudio,
  'whole-window': whole,
  'new-session': { ...whole, view: { kind: 'new', cwd: CWD }, suggestion: undefined },
  'diff-pane': { ...whole, openDiff: true },
  // The chat title bar with every item showing, for e2e/header-fit.e2e.ts: long invented title and folder, working with elapsed time, CliMayte workers.
  'header-fit': headerFit,
  // The same bar with a failed action's alert in its right block.
  'header-fit-alert': { ...headerFit, alert: 'The change failed: the Northwind workspace did not answer, so the last edit is not saved yet' },
  // The same bar beside the sidebar dragged to its narrowest, under the chrome bar that reaches past it (sidebar/width.ts).
  'header-fit-narrow-sidebar': { ...headerFit, sidebarWidth: SIDEBAR_MIN },
  'background-tasks': { ...whole, workers: backgroundTaskWorkers, openTasks: true },
  // The Settings dialog over the chat it was opened from.
  settings: { ...whole, view: { kind: 'settings' }, history: [{ kind: 'chat', id: 'pc' }, { kind: 'chat', id: 'ccd' }] },
  'external-session': {
    ...whole,
    view: { kind: 'external', id: 'x-run' },
    suggestion: undefined,
    external: [
      {
        id: 'x-run',
        title: 'Level editor export bug',
        cwd: 'C:/Users/me/Desktop/nexuscode-2d',
        source: 'desktop',
        instance: '#68',
        status: 'working',
        activity: 'Edit: src/main.ts',
        lastActivityAt: PARITY_NOW - 150_000,
        model: 'claude-opus-5-5',
        accountId: 'cli-68',
        canResume: false,
        fromPc: null,
        pinned: false,
        archived: false,
        unread: false,
        group: null
      }
    ]
  },
  'transcript-markdown': { ...whole, items: markdownSceneItems, workers: () => [], suggestion: undefined },
  'accounts-popover': { ...whole, accountsOpen: true, accounts: popoverAccounts, defaultAccountId: 'auto', pickId: '128' },
  // A chat waiting on AskUserQuestion with three questions: the card shows one at a time.
  'question-steps': {
    ...whole,
    chats: () => harvestChats().map((c): ChatSummary => (c.id === 'ccd' ? { ...c, status: 'needs_you', pendingCount: 1 } : c)),
    suggestion: undefined,
    items: () => [
      ...harvestItems(),
      {
        id: 'ask-open',
        ts: PARITY_NOW - 5_000,
        kind: 'question',
        state: 'pending',
        questions: [
          { question: 'Where should drafts be kept?', header: 'Storage', multiSelect: false, options: [{ label: 'localStorage', description: 'Simple and built in' }, { label: 'Server', description: 'Survives a browser reset' }] },
          { question: 'Which pieces should the new card show?', header: 'Pieces', multiSelect: true, options: [{ label: 'Step header', description: 'Question 1 of 3' }, { label: 'Thumbnails', description: 'Pictures in Other' }] },
          { question: 'Anything else to keep in mind?', header: 'Notes', multiSelect: false, options: [{ label: 'No', description: 'Go ahead' }] }
        ]
      }
    ]
  },
  // A chat waiting on a permission, with the SDK's own wording and the rule "Always allow" would save.
  'request-dock': {
    ...whole,
    chats: () => harvestChats().map((c): ChatSummary => (c.id === 'ccd' ? { ...c, status: 'needs_you', pendingCount: 1 } : c)),
    suggestion: undefined,
    items: () => [
      ...harvestItems(),
      {
        id: 'perm-open',
        ts: PARITY_NOW - 5_000,
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'git push origin main' },
        canAlwaysAllow: true,
        title: 'Claude wants to run git push origin main',
        alwaysRules: ['Bash(git push:*) in this project'],
        state: 'pending'
      }
    ]
  }
}

const sceneAccounts = (scene: ParityScene) => (scene.accounts ?? parityAccounts)()
const scenePick = (scene: ParityScene) => sceneAccounts(scene).find((a) => a.id === scene.pickId) ?? parityAccounts()[0]!

/** A ShellSource over local refs, like the Gallery's demo source but holding exactly the scene's data. */
export function sceneSource(scene: ParityScene): ShellSource {
  const chats = ref(scene.chats())
  const all = scene.items()
  let start = scene.windowed ? Math.max(0, all.length - scene.windowed) : 0
  const items = ref(new Map<string, TranscriptItem[]>([['ccd', all.slice(start)]]))
  const indexByChat = ref(new Map<string, TranscriptIndex>())
  if (scene.windowed)
    indexByChat.value.set('ccd', { total: all.length, userMessages: [], latestTodos: null, runningTasks: [], recentTasks: [], lastUserText: '' })
  const selected = ref<View>(scene.view)
  const settings = ref<DeskSettings>({ ...settingsFixtures, defaultAccountId: scene.defaultAccountId ?? '68' })
  const patch = (id: string, p: Partial<ChatSummary>) => {
    chats.value = chats.value.map((c) => (c.id === id ? { ...c, ...p } : c))
  }
  return {
    chats,
    itemsByChat: items,
    indexByChat,
    hasOlder: () => start > 0,
    loadOlder: async (id: string) => {
      const from = Math.max(0, start - 200)
      await new Promise((r) => setTimeout(r, 300)) // a server's answer takes a moment; the spinner shows
      const page = all.slice(from, start)
      start = from
      items.value = new Map(items.value).set(id, [...page, ...(items.value.get(id) ?? [])])
      return page.length
    },
    workers: ref(scene.workers?.() ?? cliMayteWorkerFixtures),
    external: ref(scene.external ?? []),
    accounts: ref(sceneAccounts(scene)),
    settings,
    selected,
    select: (v) => (selected.value = v),
    openSettings: () => (selected.value = { kind: 'settings' }),
    updateChat: async (id, p) => patch(id, p as Partial<ChatSummary>),
    chatServices: async () => [],
    removeChat: async (id) => (chats.value = chats.value.filter((c) => c.id !== id)),
    interrupt: async () => {},
    loadItems: async () => {},
    updateSettings: async (p) => (settings.value = { ...settings.value, ...p }),
    forkChat: async () => chats.value[0]!,
    forkExternal: async () => chats.value[0]!,
    updateSessionMeta: async () => {},
    revealFolder: async () => {},
    pickFolder: async () => null,
    changeProjectChoice: async () => {},
    search: async () => []
  } as ShellSource
}

const MODELS = [
  { value: 'claude-opus-5-5', label: 'Opus 5.5' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { value: 'claude-haiku-5-5', label: 'Haiku 5.5' }
]

function gitStatus(scene: ParityScene): GitStatus {
  return {
    isRepo: true,
    branch: scene.git.branch,
    ahead: 0,
    behind: 0,
    added: scene.git.added,
    removed: scene.git.removed,
    files: [
      { path: 'web/src/components/composer/Composer.vue', status: 'M', added: 412, removed: 96 },
      { path: 'web/src/components/sidebar/Sidebar.vue', status: 'M', added: 88, removed: 41 },
      { path: 'web/src/dev/parity/ParityPage.vue', status: '??', added: 140, removed: 0 }
    ]
  }
}

export function sceneComposerApi(scene: ParityScene): ComposerApi {
  return {
    models: async () => MODELS,
    commands: async () => [],
    git: async () => gitStatus(scene),
    recentFolders: async () => [CWD],
    rememberFolder: async () => [CWD],
    forgetFolder: async () => [],
    pickFolder: async () => null,
    browse: async (path) => ({ path: path ?? CWD, parent: 'C:/Users/me/Desktop/Project', dirs: [] }),
    accounts: async () => parityAccounts(),
    pickAccount: async () => parityAccounts()[0]!,
    mcpServers: async () => [{ name: 'agenthydra', scope: 'hydra-desk', transport: 'stdio' }],
    mcpStatus: async () => ({ live: false, servers: [] }),
    toggleMcp: async () => {},
    suggestion: () => scene.suggestion ?? null
  }
}

export function scenePaneApi(scene: ParityScene): PaneApi {
  return {
    gitStatus: async () => gitStatus(scene),
    gitDiff: async (_cwd, path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,4 @@\n import { ref } from 'vue'\n-const open = ref(false)\n+const open = ref(true)\n+const width = ref(288)\n`,
    models: async () => MODELS,
    health: async () => ({ ok: true, version: '0.1.0' }),
    bridgeStatus: async () => ({ up: true, url: 'http://127.0.0.1:7787' }),
    babysitter: async () => ({ enabled: true, everyMs: 300_000, checkedAt: null, nextCheckAt: null, stopped: [], accounts: [], acts: [], error: null }),
    instanceManager: async () => ({ enabled: true, everyMs: 20_000, checkedAt: null, nextCheckAt: null, instances: [], recoveries: [], error: null }),
    routines: async () => routinesFixtures,
    routinesAct: async () => routinesFixtures,
    routineDetails: async (_id, before = null, limit = 50) => routineDetailsFixture(before, limit),
    orchestratorModel: async () => ({ setting: 'opus', resolved: null }),
    getSettings: async () => ({ ...settingsFixtures, defaultAccountId: '68' }),
    putSettings: async (p) => ({ ...settingsFixtures, ...p }),
    accounts: async () => sceneAccounts(scene),
    pickAccount: async () => scenePick(scene),
    externalItems: async () => ({ items: scene.items(), olderBefore: 0 }),
    externalOlder: async () => [],
    // The context a session's file would give (bridge lastContextTokens), so the rail's Context card has its row.
    externalIndex: async () => ({ ...buildTranscriptIndex(scene.items()), contextTokens: 84_300 }),
    diagnostics: async () => ({ rows: [], total: 0, byCause: {}, byAccount: {}, byDay: {} }) as never,
    agentHydra: async () => {
      throw new Error('AgentHydra is not running')
    },
    freeSettings: async () => ({ ...FREE_SETTINGS_DEFAULTS }),
    patchFreeSettings: async (p) => ({ ...FREE_SETTINGS_DEFAULTS, ...p })
  }
}

PARITY_SCENES.lazy = lazy
PARITY_SCENES['header-fit-external'] = { ...PARITY_SCENES['external-session']!, sidebarHidden: true }
// The same session as a Codex chat at work in Codex: its composer and working line are a Claude chat's (owner, 2026-10-14).
PARITY_SCENES['external-codex'] = {
  ...PARITY_SCENES['external-session']!,
  external: PARITY_SCENES['external-session']!.external!.map((s) => ({ ...s, source: 'codex' as const, instance: '#7 alpha', accountId: null, codexAccountId: 'codex-7', activity: 'Using exec' }))
}
