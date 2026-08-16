export function renderHouseholdWizardSummary(ctx){
  const {
    plan,
    esc,
    money,
    taxBucketSnapshot,
    taxSummary,
  } = ctx;
  const total = taxBucketSnapshot.totalBalance || 0;
  const buckets = taxBucketSnapshot.buckets;
  const pct = value => total > 0 ? Math.round((value / total) * 100) : 0;
  const taxReady = typeof taxSummary.federalTaxLiability === 'number';
  const taxStatus = !taxReady
    ? 'not-calculable'
    : taxSummary.status === 'ready'
      ? 'ready'
      : 'partial';
  const incomeReady = typeof taxSummary.totalIncome === 'number';
  const incomeStatus = !incomeReady
    ? 'not-calculable'
    : taxSummary.status === 'ready'
      ? 'ready'
      : 'partial';
  const planningIncome = Array.isArray(plan.income?.other) ? plan.income.other : [];
  const goals = Array.isArray(plan.goals) ? plan.goals : [];
  const children = Array.isArray(plan.household?.children) ? plan.household.children : [];
  const socialSecurity = plan.income?.socialSecurity || {};
  const pension = plan.income?.pension || {};
  const pensionStartAge = Number(pension.startAge);
  const pensionBenefitByAge = pension.benefitByAge || {};
  const selectedPensionAmount = Number.isFinite(pensionStartAge)
    && Object.prototype.hasOwnProperty.call(pensionBenefitByAge, pensionStartAge)
    ? pensionBenefitByAge[pensionStartAge]
    : pension.base;
  const hasSelectedPension = Number.isFinite(pensionStartAge)
    && Number.isFinite(Number(selectedPensionAmount));
  const pctText = value => Number.isFinite(Number(value))
    ? `${(Number(value) * 100).toFixed(0)}%`
    : '—';
  const goalStart = goal => goal?.startsAtRetirement === true
    ? 'retirement'
    : goal?.startAge ?? '—';
  const goalIsOnce = goal => Number(goal?.startAge) === Number(goal?.endAge);
  const goalDisplayAmount = goal => goal?.per === 'mo' && !goalIsOnce(goal)
    ? Math.round((Number(goal?.amount) || 0) / 12)
    : Number(goal?.amount) || 0;
  const goalFrequency = goal => goalIsOnce(goal)
    ? 'once'
    : goal?.per === 'mo' ? 'per month' : 'per year';

  return `
    <div class="hh-screen hh-summary-screen" data-hh-wizard-screen="summary"
      id="hh-panel-summary" role="tabpanel" aria-labelledby="hh-nav-summary">
      <header class="hh-screen-head">
        <div>
          <div class="hh-step-kicker">Step 06</div>
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
          data-summary-income-status="${incomeStatus}">
          <span>Base-year income</span>
          <strong>${incomeReady ? money(taxSummary.totalIncome) : 'Unavailable'}</strong>
          ${incomeStatus === 'ready'
            ? '<small>Form 1040 total income</small>'
            : ''}
        </div>
        <div class="hh-summary-metric" data-summary-metric="federal-tax"
          data-summary-tax-status="${taxStatus}"
          data-summary-tax-scope="${esc(taxSummary.calculationScope || taxSummary.taxTotalScope || '')}">
          <span>Modeled federal tax</span>
          <strong>${taxReady ? money(taxSummary.federalTaxLiability) : 'Unavailable'}</strong>
          ${taxReady && typeof taxSummary.effectiveRate === 'number'
            ? `<small>Effective rate ${(taxSummary.effectiveRate * 100).toFixed(1)}%</small>`
            : ''}
        </div>
      </section>

      <section class="hh-summary-review" aria-label="Canonical intake review">
        <article data-summary-source="family">
          <h2>Family</h2>
          <dl>
            <div><dt>Client</dt><dd>${esc(plan.meta?.primaryName || '—')}</dd></div>
            ${plan.household?.spouse ? `<div><dt>Co-client</dt><dd>${esc(plan.meta?.spouseName || '—')}</dd></div>` : ''}
            <div><dt>Children</dt><dd>${children.length}</dd></div>
          </dl>
        </article>
        <article data-summary-source="income">
          <h2>Income</h2>
          <dl>
            <div><dt>Client Social Security</dt><dd>${socialSecurity.primary?.pia == null ? '—' : `${money(socialSecurity.primary.pia)} at ${esc(socialSecurity.primary.claimAge ?? 67)}`}</dd></div>
            ${plan.household?.spouse ? `<div><dt>Co-client Social Security</dt><dd>${socialSecurity.spouse?.pia == null ? '—' : `${money(socialSecurity.spouse.pia)} at ${esc(socialSecurity.spouse.claimAge ?? 67)}`}</dd></div>` : ''}
            ${planningIncome.map(source => `<div data-summary-income-source="${esc(source.id || '')}"><dt>${esc(source.label || source.typeId || 'Income')}</dt><dd>${money(source.amount)} · ${esc(source.owner || 'unassigned')} · ages ${esc(source.startAge ?? '—')}–${esc(source.endAge ?? '—')}</dd></div>`).join('')}
            ${hasSelectedPension ? `<div data-summary-pension><dt>Pension</dt><dd>${money(selectedPensionAmount)} at ${esc(pensionStartAge)} · ${esc(pension.colaPct ?? 0)}% COLA</dd></div>` : ''}
            <div data-summary-savings="annual"><dt>Annual savings</dt><dd>${money(plan.savings?.annual || 0)}</dd></div>
            <div data-summary-savings="mix"><dt>Savings mix</dt><dd>${pctText(plan.savings?.split?.traditional)} traditional · ${pctText(plan.savings?.split?.roth)} Roth · ${pctText(plan.savings?.split?.taxable)} taxable</dd></div>
          </dl>
        </article>
        <article data-summary-source="goals">
          <h2>Goals</h2>
          <dl>
            ${goals.length ? goals.map(goal => `<div data-summary-goal="${esc(goal.id || '')}"><dt>${esc(goal.name || 'Untitled goal')}</dt><dd>${money(goalDisplayAmount(goal))} ${goalFrequency(goal)} · ages ${esc(goalStart(goal))}–${esc(goal.endAge ?? goal.startAge ?? '—')}</dd></div>`).join('') : '<div><dt>Planning goals</dt><dd>None entered</dd></div>'}
          </dl>
        </article>
        <article data-summary-source="tax">
          <h2>Tax</h2>
          <dl>
            <div><dt>Filing status</dt><dd>${esc(plan.meta?.filingStatus || '—')}</dd></div>
            <div><dt>Residence</dt><dd>${esc(plan.meta?.state || '—')}</dd></div>
            <div><dt>Tax year</dt><dd>${esc(plan.incomeTax?.current1040?.taxYear ?? '—')}</dd></div>
          </dl>
        </article>
      </section>

      ${taxSummary.irmaa ? `
        <table class="hh-summary-irmaa" data-summary-irmaa aria-label="IRMAA">
          <thead>
            <tr><th scope="col">Item</th><th scope="col">Value</th></tr>
          </thead>
          <tbody>
            <tr><td>Program</td><td>IRMAA</td></tr>
            <tr><td>MAGI</td><td>${money(taxSummary.irmaa.magi)}</td></tr>
            <tr><td>Current tier</td><td>${taxSummary.irmaa.tier ?? '—'}</td></tr>
            <tr><td>Next tier</td><td>${taxSummary.irmaa.nextTier ?? '—'}</td></tr>
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
