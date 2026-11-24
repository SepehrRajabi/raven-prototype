/**
 * Where focus goes when a floating layer opens or closes. Radix hands focus to the first
 * control inside a popover, and a tooltip opens on focus: a popover whose first control
 * carries a tooltip would show it before anyone pointed at it.
 */

/** For a popover's `onOpenAutoFocus`: focus the panel itself. Tab still reaches the first control. */
export function focusPanelOnOpen(event: Event) {
  event.preventDefault();
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus({ preventScroll: true });
}

// What was used last, for `returnFocusToKeyboardOnly`. Listens on the window so it runs
// before Radix's own handlers on the document dismiss a layer.
let lastInput: "keyboard" | "pointer" = "keyboard";
if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => { lastInput = "keyboard"; }, true);
  window.addEventListener("pointerdown", () => { lastInput = "pointer"; }, true);
}

/**
 * For the `onCloseAutoFocus` of a layer whose trigger is only shown while its row is hovered
 * or holds focus. Radix returns focus to the trigger, which would keep the trigger on screen
 * after a click elsewhere, until another click. Only the keyboard needs focus back.
 */
export function returnFocusToKeyboardOnly(event: Event) {
  if (lastInput === "pointer") event.preventDefault();
}
