export function renderHouseholdWizardSummary(ctx){
  const {
    esc,
    money,
    taxBucketSnapshot,
    taxSummary,
  } = ctx;
  const total = taxBucketSnapshot.totalBalance || 0;
  const buckets = taxBucketSnapshot.buckets;
  const pct = value => total > 0 ? Math.round((value / total) * 100) : 0;
  const taxReady = taxSummary.status === 'ready'
    && typeof taxSummary.federalTaxLiability === 'number';
  const incomeReady = typeof taxSummary.totalIncome === 'number';

  return `
    <div class="hh-screen hh-summary-screen" data-hh-wizard-screen="summary"
      id="hh-panel-summary" role="tabpanel" aria-labelledby="hh-nav-summary">
      <header class="hh-screen-head">
        <div>
          <div class="hh-step-kicker">Step 04</div>
          <h1>Summary</h1>
        </div>
      </header>

      <section class="hh-summary-metrics">
        <div class="hh-summary-metric hh-summary-metric--hero" data-summary-metric="portfolio">
          <span>Portfolio</span>
          <strong>${money(total)}</strong>
          <small>${taxBucketSnapshot.buckets.taxable.accountCount
            + taxBucketSnapshot.buckets.traditional.accountCount
            + taxBucketSnapshot.buckets.roth.accountCount} funded accounts</small>
        </div>
        <div class="hh-summary-metric" data-summary-metric="income"
          data-summary-income-status="${incomeReady ? 'ready' : 'not-calculable'}">
          <span>Base-year income</span>
          <strong>${incomeReady ? money(taxSummary.totalIncome) : 'Unavailable'}</strong>
          <small>${incomeReady ? 'Form 1040 total income' : esc(taxSummary.message || 'Additional tax facts required')}</small>
        </div>
        <div class="hh-summary-metric" data-summary-metric="federal-tax"
          data-summary-tax-status="${taxReady ? 'ready' : 'not-calculable'}"
          data-summary-tax-scope="${esc(taxSummary.taxTotalScope || '')}">
          <span>Modeled federal tax</span>
          <strong>${taxReady ? money(taxSummary.federalTaxLiability) : 'Unavailable'}</strong>
          <small>${taxReady && typeof taxSummary.effectiveRate === 'number'
            ? `Effective rate ${(taxSummary.effectiveRate * 100).toFixed(1)}%`
            : esc(taxSummary.taxTotalScope || 'Needs additional facts')}</small>
        </div>
      </section>

      <section class="hh-summary-composition">
        <div class="hh-summary-section-head">
          <h2>Portfolio by tax treatment</h2>
          <span>${money(total)} across three treatments</span>
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
                <strong>${esc(buckets[key].label)}</strong>
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
