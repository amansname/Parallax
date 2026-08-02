import { escHtml } from './dom.js';
import { createTaxAwareWithdrawalController } from './taxAwareWithdrawal.js';

const BUCKET_KEYS = Object.freeze(['taxable', 'traditional', 'roth']);
const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function assertFiniteNonNegative(value, path){
  if(typeof value !== 'number' || !Number.isFinite(value) || value < 0){
    throw new TypeError(`${path} must be a finite non-negative number`);
  }
}

function formatMoney(value){
  assertFiniteNonNegative(value, 'display value');
  return money.format(value);
}

function formatSignedMoney(value){
  if(typeof value !== 'number' || !Number.isFinite(value)){
    throw new TypeError('signed display value must be finite');
  }
  if(value > 0) return `+${money.format(value)}`;
  if(value < 0) return `−${money.format(Math.abs(value))}`;
  return money.format(0);
}

function traditionalLabel(taxCharacters){
  const employer = taxCharacters.includes('employer_pretax');
  const ira = taxCharacters.some(value => [
    'traditional_ira',
    'inherited_traditional_ira',
  ].includes(value));
  if(employer && ira) return 'Tax‑Deferred · IRA & Employer';
  if(employer) return 'Tax‑Deferred · Employer Plans';
  if(ira) return 'Tax‑Deferred · IRA';
  return 'Tax‑Deferred · Traditional';
}

function taxableCharacter(taxCharacters){
  const capitalAssets = taxCharacters.some(value => [
    'capital_asset',
    'legacy_taxable',
  ].includes(value));
  const cash = taxCharacters.includes('taxable_cash');
  if(capitalAssets && cash) return 'Capital gains and taxable interest';
  if(cash) return 'Interest taxed as ordinary income';
  return 'Capital gains on sale';
}

function basisRows(snapshot){
  if(snapshot.buckets.taxable.balance <= 0) return Object.freeze([]);
  const basis = snapshot.taxableBasis;
  if(basis.status === 'not-applicable') return Object.freeze([]);
  if(basis.status === 'confirmed'){
    assertFiniteNonNegative(basis.reportedCostBasis, 'taxableBasis.reportedCostBasis');
    if(typeof basis.unrealizedGain !== 'number' || !Number.isFinite(basis.unrealizedGain)){
      throw new TypeError('taxableBasis.unrealizedGain must be finite');
    }
    return Object.freeze([
      Object.freeze({ label: 'Cost basis', value: formatMoney(basis.reportedCostBasis) }),
      Object.freeze({ label: 'Unrealized gain', value: formatSignedMoney(basis.unrealizedGain) }),
    ]);
  }
  return Object.freeze([
    Object.freeze({ label: 'Cost basis', value: 'Not confirmed' }),
    Object.freeze({ label: 'Unrealized gain', value: '—' }),
  ]);
}

function validateSnapshot(snapshot){
  if(!snapshot || snapshot.schemaVersion !== 1 || !snapshot.buckets){
    throw new TypeError('A current Tax Buckets snapshot is required');
  }
  if(!['ready', 'empty', 'incomplete'].includes(snapshot.status)){
    throw new TypeError(`Unsupported Tax Buckets snapshot status: ${snapshot.status}`);
  }
  BUCKET_KEYS.forEach(key => {
    const bucket = snapshot.buckets[key];
    if(!bucket || !Array.isArray(bucket.taxCharacters)){
      throw new TypeError(`snapshot.buckets.${key} is incomplete`);
    }
    assertFiniteNonNegative(bucket.balance, `snapshot.buckets.${key}.balance`);
  });
}

export function buildTaxBucketsViewModel(snapshot){
  validateSnapshot(snapshot);
  const taxable = snapshot.buckets.taxable;
  const traditional = snapshot.buckets.traditional;
  const roth = snapshot.buckets.roth;
  return Object.freeze({
    status: snapshot.status,
    pods: Object.freeze([
      Object.freeze({
        id: 'taxable',
        label: 'Taxable · Non‑Qualified',
        balance: formatMoney(taxable.balance),
        character: taxableCharacter(taxable.taxCharacters),
        rows: basisRows(snapshot),
      }),
      Object.freeze({
        id: 'traditional',
        label: traditionalLabel(traditional.taxCharacters),
        balance: formatMoney(traditional.balance),
        character: 'Ordinary income on withdrawal',
        rows: Object.freeze([]),
      }),
      Object.freeze({
        id: 'roth',
        label: 'Roth · Tax‑Free',
        balance: formatMoney(roth.balance),
        character: 'Tax‑free qualified withdrawals',
        rows: Object.freeze([]),
      }),
    ]),
  });
}

function renderRows(rows){
  if(!rows.length) return '';
  return `<dl class="tb-pod-rows">${rows.map(row => `
    <div class="tb-row"><dt>${escHtml(row.label)}</dt><dd>${escHtml(row.value)}</dd></div>`).join('')}
  </dl>`;
}

function renderPods(model){
  return `<div class="tb-pods">${model.pods.map((pod, index) => `
    <article class="tb-pod tb-pod-${index + 1}" aria-labelledby="tb-${pod.id}-label">
      <div class="tb-pod-label" id="tb-${pod.id}-label">${escHtml(pod.label)}</div>
      <div class="tb-pod-balance">${escHtml(pod.balance)}</div>
      <div class="tb-pod-character">${escHtml(pod.character)}</div>
      ${renderRows(pod.rows)}
    </article>`).join('')}
  </div>
  <p class="tb-footnote">Derived from Household account data.</p>`;
}

function stateMessage(status, recoveryMessage){
  if(recoveryMessage) return recoveryMessage;
  if(status === 'empty'){
    return 'No accounts entered yet — add accounts in Household to populate buckets.';
  }
  return 'Some account data needs review in Household before Tax Buckets can be shown.';
}

function renderSubNav(active){
  const currentOn = active === 'current' ? ' aria-pressed="true"' : ' aria-pressed="false"';
  const withdrawalOn = active === 'withdrawal' ? ' aria-pressed="true"' : ' aria-pressed="false"';
  return `<div class="tb-subnav" role="group" aria-label="Tax Buckets views">
    <button type="button" class="tb-subnav-btn" data-tb-sub="current"${currentOn}>Current buckets</button>
    <button type="button" class="tb-subnav-btn" data-tb-sub="withdrawal"${withdrawalOn}>Withdrawal planner</button>
  </div>`;
}

export function renderTaxBucketsPage(snapshot, {
  explored = false,
  recoveryMessage = null,
  subTab = 'current',
} = {}){
  const model = recoveryMessage ? null : buildTaxBucketsViewModel(snapshot);
  const showEntry = !explored && !recoveryMessage;
  const showPods = model?.status === 'ready';
  const content = showPods
    ? renderPods(model)
    : `<div class="tb-empty">${escHtml(stateMessage(model?.status, recoveryMessage))}</div>`;

  return `<div class="tb-glow-field" aria-hidden="true"><i class="tb-g1"></i><i class="tb-g2"></i><i class="tb-g3"></i></div>
    <div class="tb-stage">
      <section class="tb-entry" data-tb-entry${showEntry ? '' : ' hidden'}>
        <h1>Tax Buckets</h1>
        <p>See how the household’s accounts split across tax treatments — taxable, tax‑deferred, and tax‑free.</p>
        <button class="tb-cta" type="button" data-tb-explore>Explore Tax Buckets</button>
      </section>
      <section class="tb-view" data-tb-view${showEntry ? ' hidden' : ''} aria-labelledby="tb-view-title">
        ${explored || recoveryMessage ? renderSubNav(subTab) : ''}
        <div class="tb-panel" data-tb-panel="current"${subTab === 'withdrawal' ? ' hidden' : ''}>
          <div class="tb-frame">
            <header class="tb-view-head">
              <div>
                <div class="tb-kicker">Tax Buckets</div>
                <h2 id="tb-view-title">Current Tax Buckets</h2>
              </div>
            </header>
            ${content}
          </div>
        </div>
        <div class="tb-panel tb-panel--withdrawal" data-tb-panel="withdrawal"${subTab === 'current' ? ' hidden' : ''}>
          <div id="tax-aware-withdrawal-mount" class="taw-mount" data-taw-mount></div>
        </div>
      </section>
    </div>`;
}

export function createTaxBucketsController(deps){
  if(typeof deps?.getSnapshot !== 'function'){
    throw new TypeError('getSnapshot is required');
  }
  if(typeof deps?.getPlan !== 'function'){
    throw new TypeError('getPlan is required');
  }
  let root = null;
  let explored = false;
  let subTab = 'current';
  let transitionTimer = null;
  let renderToken = 0;
  const withdrawal = createTaxAwareWithdrawalController({ getPlan: deps.getPlan });

  function activateView(){
    const token = ++renderToken;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if(token !== renderToken || !root) return;
      root.querySelector('[data-tb-view]')?.classList.add('tb-live');
    }));
  }

  function showView(){
    if(!root) return;
    explored = true;
    render();
    const view = root.querySelector('[data-tb-view]');
    if(view) view.hidden = false;
    activateView();
  }

  function bindExplore(){
    const button = root?.querySelector('[data-tb-explore]');
    if(!button) return;
    button.addEventListener('click', () => {
      const entry = root?.querySelector('[data-tb-entry]');
      if(!entry) return;
      entry.classList.add('tb-leaving');
      clearTimeout(transitionTimer);
      transitionTimer = setTimeout(showView, 380);
    }, { once: true });
  }

  function ensureWithdrawalMount(){
    const mount = root?.querySelector('[data-taw-mount]');
    if(!mount) return;
    withdrawal.bind(mount);
  }

  function bindSubNav(){
    root?.querySelectorAll('[data-tb-sub]').forEach(button => {
      button.addEventListener('click', () => {
        const next = button.getAttribute('data-tb-sub');
        if(!next || next === subTab) return;
        subTab = next;
        render();
        if(subTab === 'withdrawal'){
          ensureWithdrawalMount();
          withdrawal.sync();
        }
      });
    });
  }

  function render(){
    if(!root) return;
    clearTimeout(transitionTimer);
    renderToken += 1;
    let recoveryMessage = deps.getRecoveryMessage?.() || null;
    let snapshot = null;
    if(!recoveryMessage){
      try{
        snapshot = deps.getSnapshot();
      }catch(error){
        deps.onError?.(error);
        recoveryMessage = 'Tax Buckets could not be displayed. Review Household account data.';
      }
    }
    root.innerHTML = renderTaxBucketsPage(snapshot, { explored, recoveryMessage, subTab });
    if(explored || recoveryMessage) activateView();
    else bindExplore();
    bindSubNav();
    if(subTab === 'withdrawal') ensureWithdrawalMount();
  }

  function bind(element){
    if(!element) throw new TypeError('Tax Buckets mount is required');
    root = element;
    render();
  }

  function sync(){
    render();
    if(subTab === 'withdrawal') withdrawal.sync();
  }

  return Object.freeze({
    bind,
    sync,
    hasExplored: () => explored,
  });
}
