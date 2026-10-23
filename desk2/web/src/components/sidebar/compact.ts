// The chrome bar's Compact sidebar button (owner, 2026-10-10: "a compact mode ... it removes the headers"): the desk
// list and the cloud list drop their project group headers, keep the chats in their groups and order as one list,
// and show each chat's project icon in a ring where its status dot was (sidebar/ProjectRing.vue). On by default (owner,
// 2026-10-22: compact mode is the default for whoever installs); the menu's tick says whether it is on.
import { ref, watch } from 'vue'

const KEY = 'hydra-desk.sidebar.compact'
const storage = typeof localStorage === 'undefined' ? null : localStorage
/** On: no project headers, the project icon in a ring for each row. Remembered; on until the menu turns it off. */
export const compactSidebar = ref(storage?.getItem(KEY) !== '0')
watch(compactSidebar, (v) => storage?.setItem(KEY, v ? '1' : '0'))
