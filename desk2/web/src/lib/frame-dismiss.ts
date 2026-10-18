// A click into one of this window's frames (AgentHydra's pane, a dev server's page) never reaches this document, so an
// open menu or popover stayed open: reka's layers close on a pointerdown outside them, heard on this document
// (DismissableLayer), and focus moving into a frame fires no focusin here either. The window's blur with a frame
// focused is that click as this document sees it, so it is handed on as one, from the frame. 2026-10-14: the account
// menu stayed open over AgentHydra's Instances tab (owner: "this menu does not close, if I click outside of it, it
// should"); measured headless, a click on the chat or the sidebar closed it and a click into a frame did not.

export function closeLayersOnFrameClick(win: Window & typeof globalThis = window): () => void {
  const onBlur = () => {
    // Focus lands on the frame only after the window's blur, so look once the blur is done.
    win.setTimeout(() => {
      const frame = win.document.activeElement
      if (frame instanceof win.HTMLIFrameElement)
        frame.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0 }))
    }, 0)
  }
  win.addEventListener('blur', onBlur)
  return () => win.removeEventListener('blur', onBlur)
}
