export function renderSavingsReplacement({ pending, ownerName, typeLabel, money, esc }){
  if(!pending) return '';
  return `
    <section class="hh-savings-review" data-savings-replacement
      aria-labelledby="hh-savings-replacement-title" aria-describedby="hh-savings-replacement-description">
      <h3 id="hh-savings-replacement-title" tabindex="-1" data-savings-replacement-heading>Replace existing savings?</h3>
      <p id="hh-savings-replacement-description">Your plan currently uses
        ${money(pending.confirmation.priorAnnual)} a year. Saving this entry will replace that total with
        ${money(pending.confirmation.itemizedAnnual)} a year for ${esc(ownerName)} · ${esc(typeLabel)}.</p>
      <p>Confirm that this entry is your intended total savings. You can add more entries afterward.</p>
      <div class="hh-savings-review-actions">
        <button type="button" class="px-btn px-btn--prominent" data-hh-action="cancel-savings-replacement">Keep current savings</button>
        <button type="button" class="px-btn px-btn--prominent px-btn--primary" data-hh-action="confirm-savings-replacement">Replace savings</button>
      </div>
    </section>`;
}

export function renderSavingsHistory(plan, money){
  const archive = plan.meta?.legacyRepairArchive;
  const updates = (Array.isArray(archive) ? archive : []).filter(record =>
    ['HIDDEN_SAVINGS_AGGREGATE_RECONCILED', 'LEGACY_SAVINGS_REPLACED'].includes(record?.code)
    && Number.isFinite(record.priorAnnual) && Number.isFinite(record.itemizedAnnual));
  if(updates.length === 0) return '';
  return `
    <details class="hh-savings-history" data-savings-history>
      <summary>Review earlier savings updates</summary>
      ${updates.map(record => `<p data-savings-history-entry>${record.code === 'LEGACY_SAVINGS_REPLACED'
        ? 'You confirmed a change' : 'An earlier update changed the annual savings total'}
        from ${money(record.priorAnnual)} to ${money(record.itemizedAnnual)} a year
        to use the saved entries.</p>`).join('')}
      <p>These are past updates. Review your entries if the current total differs from your intended savings.</p>
    </details>`;
}
