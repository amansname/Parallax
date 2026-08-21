export function renderHouseholdWizardSummary(ctx){
  const {
    esc,
    money,
    taxBucketSnapshot,
    taxSummary,
  } = ctx;
  const total = taxBucketSnapshot.totalBalance || 0;
  const buckets = taxBucketSnapshot.buckets;
  const bucketLabels = {
    taxable: buckets.taxable.label,
    traditional: 'Traditional',
    roth: buckets.roth.label,
  };
  const pct = value => total > 0 ? Math.round((value / total) * 100) : 0;

  return `
    <div class="hh-screen hh-summary-screen" data-hh-wizard-screen="summary"
      id="hh-panel-summary" role="tabpanel" aria-labelledby="hh-nav-summary">
      <section class="hh-summary-metrics">
        <div class="hh-summary-metric hh-summary-metric--hero" data-summary-metric="portfolio">
          <span>Portfolio</span>
          <strong>${money(total)}</strong>
        </div>
      </section>

      ${taxSummary.irmaa ? `
        <table class="hh-summary-irmaa" data-summary-irmaa aria-label="IRMAA">
          <caption>IRMAA</caption>
          <thead>
            <tr><th scope="col">Item</th><th scope="col">Value</th></tr>
          </thead>
          <tbody>
            <tr><td>MAGI</td><td>${money(taxSummary.irmaa.magi)}</td></tr>
            <tr><td>Current tier</td><td>${taxSummary.irmaa.tier ?? '—'}</td></tr>
            <tr><td>To next tier</td><td>${typeof taxSummary.irmaa.roomToNext === 'number'
              ? money(taxSummary.irmaa.roomToNext)
              : '—'}</td></tr>
            <tr><td>Premium year</td><td>${taxSummary.irmaa.premiumYear}</td></tr>
          </tbody>
        </table>
      ` : ''}

      <section class="hh-summary-composition">
        <div class="hh-summary-section-head">
          <h2>Portfolio by tax treatment</h2>
        </div>
        <div class="hh-composition-layout">
          <div class="hh-composition-bar" aria-label="Portfolio tax-treatment composition">
            <span class="is-taxable" style="width:${pct(buckets.taxable.balance)}%"></span>
            <span class="is-traditional" style="width:${pct(buckets.traditional.balance)}%"></span>
            <span class="is-roth" style="width:${pct(buckets.roth.balance)}%"></span>
          </div>
          <div class="hh-composition-legend">
            ${['taxable', 'traditional', 'roth'].map(key => `
              <div data-summary-bucket="${key}">
                <span class="hh-legend-swatch is-${key}"></span>
                <strong>${esc(bucketLabels[key])}</strong>
                <small>${pct(buckets[key].balance)}%</small>
                <b>${money(buckets[key].balance)}</b>
              </div>
            `).join('')}
          </div>
        </div>
      </section>
    </div>
  `;
}
