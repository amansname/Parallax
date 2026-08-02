import { escHtml } from './dom.js';
import { createTaxAwareWithdrawalController } from './taxAwareWithdrawal.js';

/** Tax Buckets tab — hosts the tax-aware withdrawal planner only. */
export function createTaxBucketsController(deps) {
  if (typeof deps?.getPlan !== 'function') {
    throw new TypeError('getPlan is required');
  }
  const planner = createTaxAwareWithdrawalController({ getPlan: deps.getPlan });
  let root = null;

  function renderBlocked() {
    if (!root) return;
    const message = deps.getBlockedMessage?.()
      || 'Household data is unavailable. Resolve storage to use Tax Buckets.';
    root.innerHTML = `<div class="taw-blocked" role="status">${escHtml(message)}</div>`;
  }

  function bind(element) {
    if (!element) throw new TypeError('Tax Buckets mount is required');
    root = element;
    if (deps.isStorageBlocked?.()) {
      renderBlocked();
      return;
    }
    planner.bind(element);
  }

  function sync() {
    if (!root) return;
    if (deps.isStorageBlocked?.()) {
      renderBlocked();
      return;
    }
    planner.sync();
  }

  return Object.freeze({
    bind,
    sync,
    hasExplored: () => true,
  });
}
