// The chrome bar's Compact sidebar button (owner, 2026-10-10: "a compact mode ... it removes the headers"): the desk
// list and the cloud list drop their project group headers, keep the chats in their groups and order as one list,
// and show each chat's project icon in a ring where its status dot was (sidebar/ProjectRing.vue). Off by default;
// the button is blue while it is on, as Cloud and CliMayte are.
import { ref, watch } from 'vue'

const KEY = 'hydra-desk.sidebar.compact'
const storage = typeof localStorage === 'undefined' ? null : localStorage
/** On: no project headers, the project icon in a ring for each row. Remembered; off until the button turns it on. */
export const compactSidebar = ref(storage?.getItem(KEY) === '1')
watch(compactSidebar, (v) => storage?.setItem(KEY, v ? '1' : '0'))
