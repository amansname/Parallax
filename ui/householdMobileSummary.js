import { householdNetWorthTotals } from '../src/household/netWorthTotals.js';

export function renderHouseholdMobileSummary({ plan, esc, money, taxBucketSnapshot, taxSummary, ageFor }){
  const members = [{ owner: 'client', key: 'primary', name: plan.meta?.primaryName }];
  if(plan.household?.spouse) members.push({ owner: 'spouse', key: 'spouse', name: plan.meta?.spouseName });
  const filing = { single: 'Single', marriedFilingJointly: 'Married filing jointly', headOfHousehold: 'Head of household' }[plan.meta?.filingStatus] || 'Unsupported filing status';
  const total = householdNetWorthTotals(plan, taxBucketSnapshot).netWorthTotal;
  const row = (label, value) => `<div class="hh-mobile-summary-row"><span>${label}</span><strong>${esc(value)}</strong></div>`;
  return `<section class="hh-mobile-summary">
    <header><p>Household summary</p><h2>${esc(members.map(member => member.name).filter(Boolean).join(' & ') || 'Your household')}</h2></header>
    <div class="hh-mobile-summary-people">${members.map(member => `<button type="button" data-mobile-household-step="family" data-mobile-owner="${member.owner}"><span class="hh-mobile-avatar" aria-hidden="true">${esc(member.name?.[0] || '+')}</span><span><strong>${esc(member.name || 'Add name')}</strong><small>Age ${ageFor(member.owner) ?? '—'} · Retires ${plan.household?.[member.key]?.retirementAge ?? '—'}</small></span><span aria-hidden="true">›</span></button>`).join('')}</div>
    <button type="button" class="hh-mobile-summary-worth" data-mobile-household-step="net-worth"><span>Net worth<strong>${money(total)}</strong></span><span aria-hidden="true">↗</span></button>
    ${taxSummary.status === 'ready' && Number.isFinite(taxSummary.totalIncome) ? row('Current-year income', money(taxSummary.totalIncome)) : ''}
    ${Number.isFinite(plan.savings?.annual) ? row('Savings / year', money(plan.savings.annual)) : ''}
    ${row('Filing status', filing)}${row('State', plan.meta?.state || 'Not entered')}
  </section>`;
}
