/* ── Inputs tab: edit the base plan (household data root) ──────────────────
   `plan` is the single source. Scenarios draw their baseline from it; each
   scenario then carries its own adjustment. Editing a base input re-seeds
   every column from the NEW base while PRESERVING each scenario's delta (its
   decision) — so "draw from base, then adjust" holds automatically. */

// Live comma formatting for money inputs. Reformats on every keystroke and
// preserves the caret's LOGICAL position (after the same number of digits)
// so typing left-to-right feels natural — no caret-jumping-to-end weirdness.
export function liveCommas(el) {
  const old = el.value;
  const caret = el.selectionStart ?? old.length;
  const digitsBefore = (old.slice(0, caret).match(/\d/g) || []).length;
  const digits = old.replace(/[^0-9]/g, '');
  if (!digits) {
    el.value = '';
    return;
  }
  const formatted = parseInt(digits, 10).toLocaleString('en-US');
  el.value = formatted;
  let pos = 0,
    seen = 0;
  while (pos < formatted.length && seen < digitsBefore) {
    if (/\d/.test(formatted[pos])) seen++;
    pos++;
  }
  el.setSelectionRange(pos, pos);
}
