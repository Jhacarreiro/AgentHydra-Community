// The dashboard page's state and the list every entry point reads (the home grid's glyphs, the session header's count).
import { ref, shallowRef } from 'vue'
import type { DashboardSummary } from '@shared/dashboards'
import { listDashboards } from './api'

/** The page on screen (or sliding out), and the folder it shows. */
export const dashboardOpen = ref(false)
export const dashboardCwd = ref<string | null>(null)

export function openDashboard(cwd: string): void {
  dashboardCwd.value = cwd
  dashboardOpen.value = true
}

export function closeDashboard(): void {
  dashboardOpen.value = false
}

/** The page's Open in tab: DeskFrame slides the page back and the browser pane shows the site in a tab, in its folder. */
export const dashboardTab = shallowRef<{ cwd: string; url: string } | null>(null)

export function openDashboardTab(cwd: string, url: string): void {
  dashboardTab.value = { cwd, url }
}

/** Replaced whole on each read, so shallow. null until the first answer. */
export const dashboardList = shallowRef<DashboardSummary[] | null>(null)

let inFlight: Promise<void> | null = null
export function refreshDashboards(): Promise<void> {
  inFlight ??= listDashboards()
    .then((res) => {
      dashboardList.value = res.dashboards
    })
    .catch(() => {
      // Entry points keep the last list; the page shows its own error line.
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}
