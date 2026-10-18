// The To-do pane's shared state: whether 4MAN is installed (read once at start and on window focus), the folder a
// group head asked the pane to show, and the folder the open pane shows.
import { ref, shallowRef } from 'vue'
import { fourmanStatus } from './api'
import { fourmanOn } from './logic'

export const fourmanAvailable = ref(false)
export const todoRequest = shallowRef<{ cwd: string } | null>(null)
export const todoShowing = shallowRef<string | null>(null)

let started = false

async function refresh(): Promise<void> {
  try {
    fourmanAvailable.value = fourmanOn(await fourmanStatus())
  } catch {
    fourmanAvailable.value = false
  }
}

export function startFourman(): void {
  if (started) return
  started = true
  void refresh()
  window.addEventListener('focus', () => void refresh())
}

export function requestTodo(cwd: string): void {
  todoRequest.value = { cwd }
}
