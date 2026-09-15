import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Keyboard behaviour shared by every dialog in the panel: move focus in on
 * open, keep it inside while open, hand it back to whatever opened the dialog
 * on close, and close on Escape.
 *
 * Both dialogs needed this and neither had all of it. `Modal` had none: opening
 * "Create user" left focus on the page behind and Tab walked the obscured
 * filters, so no field in any modal could be reached by keyboard. `ConfirmDialog`
 * focused its primary button but did not contain Tab, so one press from a
 * "Delete permanently?" prompt landed in the sidebar and Cancel was unreachable.
 * One hook, so the two cannot drift apart again.
 *
 * `isTopmost` is what makes stacking safe. A confirmation can open on top of a
 * modal — "Delete" in a contact thread, "Remove" on an installer — and it is
 * rendered after {children} by the provider, so it is always later in document
 * order. The layer underneath stands down rather than dragging focus back out
 * of the prompt and answering the same Escape.
 *
 * @param {boolean} open
 * @param {() => void} onClose        called on Escape
 * @param {{ initialFocus?: React.RefObject<HTMLElement> }} [options]
 *        where to land on open; defaults to the first form control, else the
 *        first focusable. A confirmation passes its primary button so Enter
 *        confirms, which is the behaviour it already had.
 * @returns {React.RefObject<HTMLElement>} ref to put on the dialog panel
 */
export default function useDialogFocus(open, onClose, { initialFocus } = {}) {
  const panel = useRef(null);
  const returnTo = useRef(null);

  // Call sites pass an inline arrow for onClose, so its identity changes every
  // render. Depending on it would re-run this effect constantly and yank focus
  // back to the first field while someone was typing in the third.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const initialRef = useRef(initialFocus);
  initialRef.current = initialFocus;

  useEffect(() => {
    if (!open) return undefined;
    const node = panel.current;
    if (!node) return undefined;

    returnTo.current = document.activeElement;

    const focusables = () => [...node.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    const isTopmost = () => {
      const layers = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')];
      return !layers.length || layers[layers.length - 1] === node;
    };

    const list = focusables();
    const wanted = initialRef.current?.current;
    // Prefer a form control over the header's close button: a dialog that opens
    // with "Close" focused reads as an exit, not a form.
    const firstField = list.find((el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName));
    (wanted || firstField || list[0] || node).focus();

    function onKey(e) {
      if (!isTopmost()) return;
      if (e.key === 'Escape') { onCloseRef.current?.(); return; }
      if (e.key !== 'Tab') return;
      const current = focusables();
      if (!current.length) { e.preventDefault(); node.focus(); return; }
      const first = current[0];
      const last = current[current.length - 1];
      const inside = node.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault(); first.focus();
      }
    }

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const back = returnTo.current;
      returnTo.current = null;
      // Returning focus to the row's "Manage" button is what makes closing a
      // dialog feel like going back rather than starting over.
      if (back && document.contains(back) && typeof back.focus === 'function') back.focus();
    };
  }, [open]);

  return panel;
}
