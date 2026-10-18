// AgentHydra's desktop instances, one list for the window: the session header's account chip and Migrate, and the
// row menu's first line and Move to account (sidebar/logic.ts). Read when one of them opens, at most every 15 s
// unless asked to; the address an instance was resolved to (ah.instanceAccount) is kept across reads, which do not
// carry it. AgentHydra's Codex accounts are read with them, for a Codex chat's row menu.
import { computed, ref, shallowRef } from 'vue'
import type { AccountChoice } from '@/components/sidebar/logic'
import { ah } from './ah'
import { instanceName, type AhCodexInstance, type AhInstance } from './logic'

const FRESH_MS = 15_000

/** null until AgentHydra first answers. */
export const ahInstances = ref<AhInstance[] | null>(null)
/** AgentHydra's Codex accounts; null until it first answers. */
export const ahCodexInstances = shallowRef<AhCodexInstance[] | null>(null)
let reading: Promise<void> | null = null
let readAt = 0

/** Reads the list again unless it is fresh; `force` reads it anyway (running state moves while a menu stays open). */
export function refreshAhInstances(force = false): Promise<void> {
  if (reading) return reading
  if (!force && ahInstances.value && Date.now() - readAt < FRESH_MS) return Promise.resolve()
  // /instances sends no account, so a menu named each by its folder ("aaa", "ccc"; owner, 2026-10-15: "it should
  // show the account name"): the fleet numbering carries who each is signed into, read off disk in one call.
  const named = ah.instanceNumbers().then(
    (list) => new Map(list.filter((x) => x.kind === 'desktop' && (x.name || x.email)).map((x) => [x.handle.toLowerCase(), { name: x.name, email: x.email }])),
    () => new Map<string, NonNullable<AhInstance['account']>>()
  )
  const desktop = Promise.all([ah.instances(), named]).then(
    ([list, signedIn]) => {
      const known = new Map((ahInstances.value ?? []).map((x) => [x.dir, x.account]))
      ahInstances.value = list.map((x) => {
        if (x.account?.email) return x
        const account = known.get(x.dir) ?? signedIn.get(x.dir.toLowerCase()) ?? null
        return account ? { ...x, account } : x
      })
      readAt = Date.now()
    },
    () => {}
  )
  const codex = ah.codexInstances().then(
    (list) => void (ahCodexInstances.value = list),
    () => {}
  )
  reading = Promise.all([desktop, codex])
    .then(() => {})
    .finally(() => (reading = null))
  return reading
}

/** The account an instance turned out to be signed into, kept for the next reads. */
export function setInstanceAccount(dir: string, account: AhInstance['account']): void {
  if (ahInstances.value) ahInstances.value = ahInstances.value.map((x) => (x.dir === dir ? { ...x, account } : x))
}

/**
 * What Move to account offers, by the name the header's Migrate uses; null until the list is read. `tag` is the
 * instance's own name, which AgentHydra's session list gives a desktop chat's account when it is not `#num` ("moarz"
 * for #194): without it such a chat was on no account, so nothing was ticked and Unassign named no account.
 */
export const accountChoices = computed<AccountChoice[] | null>(
  () => ahInstances.value?.map((i) => ({ ref: `desktop:${i.dir}`, num: i.num, name: instanceName(i), running: i.isRunning, tag: i.name })) ?? null
)

/**
 * What Move to account offers a Codex chat: the Codex accounts a chat can move to (AgentHydra's own, signed into
 * ChatGPT, as the Instances page's Move chats offers them), named as the Instances table names them. `tag` is the
 * name AgentHydra's session list gives their chats, which is how a row finds the account it is on.
 */
export const codexAccountChoices = computed<AccountChoice[] | null>(
  () =>
    ahCodexInstances.value
      ?.filter((i) => !i.isExternal && i.account?.authMode === 'chatgpt')
      .map((i) => ({
        ref: `codex:${i.id}`,
        num: i.num,
        name: instanceName({ name: i.name, label: i.ownName ? i.name : null, account: i.account }),
        running: i.isDesktopRunning,
        tag: i.name
      })) ?? null
)
