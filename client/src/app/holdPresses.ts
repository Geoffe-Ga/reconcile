import type { PointerEvent } from 'react';

/**
 * Keeps a press from starting on a button while it saves. React Aria's
 * usePress starts one on pointerdown even on a disabled button, and a browser
 * gives a disabled button pointerdown and pointerup but no click, so 80 ms later
 * usePress clicks the button itself. If saving finished within those 80 ms, the
 * button was enabled again and the action ran a second time (#190, #192). Set
 * it as `onPointerDownCapture` on the row that holds the saving buttons.
 */
export function holdPresses(saving: boolean) {
  return (event: PointerEvent) => {
    if (saving) event.stopPropagation();
  };
}
