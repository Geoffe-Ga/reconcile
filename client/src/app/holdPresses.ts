import type { PointerEvent } from 'react';

/**
 * Keeps a press from starting on a control while its action runs (#190, #192,
 * #193). React Aria's usePress starts one on pointerdown even on a disabled
 * control, and a browser gives a disabled control pointerdown and pointerup but
 * no click, so 80 ms later usePress clicks the control itself. If the action
 * finished within those 80 ms, the control was enabled again, and that click
 * did what a click does: a submit button sent its form a second time, and a
 * checkbox, radio or switch changed. (An `onPress` handler never runs for a
 * press that started while disabled, so a plain button is safe.)
 *
 * Set it as `onPointerDownCapture` on the row that holds the controls disabled
 * while the action runs, or on the one button when its row holds others that
 * stay enabled.
 */
export function holdPresses(running: boolean) {
  return (event: PointerEvent) => {
    if (running) event.stopPropagation();
  };
}
