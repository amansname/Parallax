import { escHtml } from './dom.js';
import { resolvePortfolioAccounts } from '../src/household/resolvePortfolioAccounts.js';

export function investableTotal(plan){
  return resolvePortfolioAccounts(plan).totalBalance;
}

// Essential spending is the pre-loaded Essentials + Healthcare goals. Both are
// goals now — plan.expenses is retired.
export function systemGoalTotal(plan){
  return (Array.isArray(plan?.goals) ? plan.goals : [])
    .filter(g => g?.system)
    .reduce((sum, g) => sum + (Number(g.amount) || 0), 0);
}

export function realAssetsTotal(plan){ return (plan.properties||[]).reduce((s,a)=>s+(a.value||0),0); }

export function hhAllAccounts(plan){
  const rows = [];
  (plan.portfolio.extraAccounts || []).forEach((x,i) => {
    rows.push({ label: x.type || 'Account', balance: x.balance||0, owner: x.owner || 'joint', bucket: x.bucket || 'taxable',
      typePath:`portfolio.extraAccounts.${i}.type`,
      balPath:`portfolio.extraAccounts.${i}.balance`, ownerPath:`portfolio.extraAccounts.${i}.owner`, idx:i });
  });
  return rows;
}

export function hhDebtTotal(plan){
  const mort = (plan.properties||[]).reduce((s,p)=>s+((p.mortgage&&p.mortgage.balance)||0),0);
  const liab = (plan.liabilities||[]).reduce((s,l)=>s+(l.amount||0),0);
  return mort + liab;
}

export function hhNetWorthTotal(plan){ return investableTotal(plan) + realAssetsTotal(plan) - hhDebtTotal(plan); }

export function hhAgeFromYear(y){
  const n = Number(y);
  if(!Number.isFinite(n) || n < 1900) return null;
  return Math.max(0, new Date().getFullYear() - Math.round(n));
}

export function hhFilingLine(plan){
  const FS = { marriedFilingJointly:'Married filing jointly', single:'Single', headOfHousehold:'Head of household', marriedFilingSeparately:'Married filing separately' };
  const fs = plan.meta && plan.meta.filingStatus;
  const hasSpouse = !!(plan.household && plan.household.spouse);
  if(fs && FS[fs]) return FS[fs] + (hasSpouse ? ' · two-person household' : '');
  return hasSpouse ? 'Two-person household' : 'Single household';
}

export function hhInitial(name, fallback){ const n=(name||'').trim(); return n ? n.charAt(0).toUpperCase() : fallback; }

export function hhMoney(v){ const n=Math.round(Number(v)||0); return (n<0?'–$':'$') + Math.abs(n).toLocaleString('en-US'); }
export function hhShort(v){ const n=Number(v)||0, a=Math.abs(n), s=n<0?'–':''; if(a>=1e6) return s+'$'+(a/1e6).toFixed(2).replace(/\.?0+$/,'')+'M'; if(a>=1e3) return s+'$'+Math.round(a/1e3)+'K'; return s+'$'+Math.round(a); }

export function hhSelect(path, value, opts, kind){
  const o = opts.map(([v,l]) => `<option value="${v}" ${v===value?'selected':''}>${l}</option>`).join('');
  return `<select data-path="${path}" data-type="${kind}" class="hh-sel hh-sel--${kind}">${o}</select>`;
}

export function wizField(label, html, cls){
  return `<label class="hh-wf${cls?' '+cls:''}"><span class="hh-wf__k">${label}</span><span class="hh-wf__v">${html}</span></label>`;
}

export function renderWizBlueprint(plan){
  const all = hhAllAccounts(plan);
  const sum = o => all.filter(x=>x.owner===o).reduce((s,x)=>s+(x.balance||0),0);
  const cInv = sum('client'), sInv = sum('spouse'), jInv = sum('joint')+sum('trust');
  const base = cInv + sInv, cPct = base ? Math.round(cInv/base*100) : 0, sPct = base ? 100-cPct : 0;
  const ss = plan.income.socialSecurity || {};
  const pen = plan.income.pension || {};
  const penAmt = (pen.startAge!=null && pen.benefitByAge) ? (pen.benefitByAge[pen.startAge]||0) : 0;
  const otherSum = (plan.income.other||[]).reduce((t,o)=>t+(o.amount||0),0);
  const c = plan.meta.primaryName||'Client', s = plan.meta.spouseName||'Co-Client';
  const hh = plan.household, sp = hh.spouse;
  const line = (k,v,cls) => `<div class="hh-bp__row"><span class="hh-bp__k">${k}</span><b class="hh-bp__v ${cls||''}">${v}</b></div>`;
  const people = `${escHtml(c)} · ${hh.primary.currentAge}, retires ${hh.primary.retirementAge}`
    + (sp ? `<br>${escHtml(s)} · ${sp.currentAge}, retires ${sp.retirementAge}` : '');
  return `<div class="hh-bp">
    <div class="hh-bp__hero">
      <div class="hh-bp__label">Household net worth</div>
      <div class="hh-bp__total">${hhMoney(hhNetWorthTotal(plan))}</div>
      <div class="hh-own">
        <div class="hh-own__bar"><div class="hh-own__c" style="width:${cPct}%;"></div><div class="hh-own__s" style="width:${sPct}%;"></div></div>
        <div class="hh-own__legend"><span>Client ${cPct}%</span><span>Co-Client ${sPct}%</span></div>
      </div>
    </div>
    <div class="hh-bp__grid">
      <div class="hh-bp__col">
        <div class="hh-bp__head">Household</div>
        ${line('People', people)}
        ${line('Filing', hhFilingLine(plan))}
        ${line('State', (plan.meta&&plan.meta.state)||'—')}
        ${line('Plan to age', hh.primary.planEndAge)}
      </div>
      <div class="hh-bp__col">
        <div class="hh-bp__head">Assets</div>
        ${line('Client accounts', hhMoney(cInv))}
        ${line('Co-client accounts', hhMoney(sInv))}
        ${line('Joint & trust', hhMoney(jInv))}
        ${line('Real assets', hhMoney(realAssetsTotal(plan)))}
        ${line('Debt', hhMoney(-hhDebtTotal(plan)), 'hh-bp__v--debt')}
      </div>
      <div class="hh-bp__col">
        <div class="hh-bp__head">Retirement cash flow</div>
        ${line('Social Security', hhMoney(((ss.primary&&ss.primary.pia)||0)+((ss.spouse&&ss.spouse.pia)||0))+'/yr')}
        ${penAmt ? line('Pension @ '+pen.startAge, hhMoney(penAmt)+'/yr') : ''}
        ${otherSum ? line('Other income', hhMoney(otherSum)+'/yr') : ''}
        ${line('Essential spend', hhMoney(systemGoalTotal(plan))+'/yr')}
        ${line('Saving until then', hhMoney((plan.savings&&plan.savings.annual)||0)+'/yr')}
      </div>
    </div>
  </div>`;
}

export function renderWizRail(plan, hhStep){
  if(hhStep === 5) return '';
  const ss = plan.income.socialSecurity || {};
  const ssTotal = ((ss.primary&&ss.primary.pia)||0) + ((ss.spouse&&ss.spouse.pia)||0);
  const ess = systemGoalTotal(plan);
  const row = (k,v,cls) => `<div class="hh-prail__row"><span class="hh-prail__k">${k}</span><b class="hh-prail__v ${cls||''}">${v}</b></div>`;
  const rows = [];
  if(hhStep !== 2){
    rows.push(row('Investable', hhShort(investableTotal(plan))));
    rows.push(row('Real assets', hhShort(realAssetsTotal(plan))));
    rows.push(row('Debt', hhShort(-hhDebtTotal(plan)), 'hh-prail__v--debt'));
  }
  if(hhStep !== 3) rows.push(row('Social Security', hhShort(ssTotal)+'/yr'));
  if(hhStep !== 4) rows.push(row('Essential spend', hhShort(ess)+'/yr'));
  if(hhStep !== 2) rows.push(row('Annual savings', hhShort((plan.savings&&plan.savings.annual)||0)+'/yr'));
  return `<div class="hh-prail">
    <div class="hh-prail__eyebrow">Plan so far</div>
    <div class="hh-prail__label">Net worth</div>
    <div class="hh-prail__total">${hhMoney(hhNetWorthTotal(plan))}</div>
    ${rows.join('')}
  </div>`;
}
