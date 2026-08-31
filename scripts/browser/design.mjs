// Existing browser assertions; run by scripts/verify.mjs in campaign order.
import { goToWizardStep } from '../wizard-browser-contract.mjs';
export async function verifyDesign({
  VERIFIED_ARTIFACT,
  page,
  stableEvaluate,
  stableClick,
  setCashFlow
}) {
  const artifactId = VERIFIED_ARTIFACT.manifest.artifactId;
  await page.setViewport({
    width: 1279,
    height: 1600,
    deviceScaleFactor: 1
  });
  await stableEvaluate('disable nonessential design transitions', () => {
    const style = document.createElement('style');
    style.dataset.verifyMotion = 'disabled';
    style.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
    document.head.append(style);
  });
  const desktop = await stableEvaluate('read desktop Graphite Aubergine contract', expectedArtifactId => {
    const rootStyle = getComputedStyle(document.documentElement);
    const bodyStyle = getComputedStyle(document.body);
    const headerBar = document.querySelector('.app-header .hdr__bar');
    const themeLinks = [...document.querySelectorAll('link[rel="stylesheet"]')].map(link => link.getAttribute('href')).filter(href => href?.startsWith('styles/parallax-layout.css'));
    const navLabels = [...document.querySelectorAll('.app-header .htab')].map(button => button.textContent.trim());
    return {
      bodyBackground: bodyStyle.backgroundColor,
      bodyColor: bodyStyle.color,
      bodyFont: bodyStyle.fontFamily,
      rootOverflowY: rootStyle.overflowY,
      bodyOverflowY: bodyStyle.overflowY,
      headerBars: headerBar ? document.querySelectorAll('.app-header .hdr__bar').length : 0,
      navLabels,
      themeLinks,
      expectedThemeLink: `styles/parallax-layout.css?v=${expectedArtifactId}`,
      spectralLoaded: [...document.querySelectorAll('link[rel="stylesheet"]')].some(link => /Spectral/i.test(link.getAttribute('href') || ''))
    };
  }, artifactId);
  if (desktop.bodyBackground !== 'rgb(24, 25, 24)' || desktop.bodyColor !== 'rgb(148, 138, 121)' || !desktop.bodyFont.includes('Hanken Grotesk') || desktop.rootOverflowY === 'hidden' || desktop.bodyOverflowY === 'hidden') {
    throw new Error(`Graphite Aubergine tokens are not active: ${JSON.stringify(desktop)}`);
  }
  if (desktop.headerBars !== 1 || JSON.stringify(desktop.navLabels) !== JSON.stringify(['Household', 'Goals', 'Scenarios', 'Withdrawal planner', 'Sequencing'])) {
    throw new Error(`Graphite Aubergine header contract drifted: ${JSON.stringify(desktop)}`);
  }
  if (desktop.themeLinks.length !== 1 || desktop.themeLinks[0] !== desktop.expectedThemeLink || desktop.spectralLoaded) {
    throw new Error(`Graphite Aubergine font or artifact stylesheet drifted: ${JSON.stringify(desktop)}`);
  }
  await stableClick('.htab[data-page="tax-buckets"]');
  await page.waitForFunction(() => document.querySelector('.page[data-page="tax-buckets"].on [data-taw-root]')?.getAttribute('aria-busy') === 'false', {
    timeout: 10000
  });
  const plannerPresentation = await stableEvaluate('read Withdrawal Planner presentation contract', () => ({
    pageHead: Boolean(document.querySelector('.page[data-page="tax-buckets"].on .taw-page-head')),
    context: Boolean(document.querySelector('.page[data-page="tax-buckets"].on .taw-plan-context')),
    grid: Boolean(document.querySelector('.page[data-page="tax-buckets"].on .taw-grid'))
  }));
  if (plannerPresentation.pageHead || plannerPresentation.context || !plannerPresentation.grid) {
    throw new Error(`Withdrawal Planner compact presentation drifted: ${JSON.stringify(plannerPresentation)}`);
  }
  await stableClick('.htab[data-page="scenarios"]');
  await setCashFlow(page, true);
  const cashFlowTheme = await stableEvaluate('read Cash Flow Graphite Aubergine toggle', () => {
    const chip = document.querySelector('#scn-cash-toggle');
    const label = chip?.querySelector('.cash-chip__label');
    const knob = chip?.querySelector('.switch__knob');
    const paths = [...document.querySelectorAll('#cashflow-path-mode option')].map(option => option.value);
    return {
      checked: chip?.getAttribute('aria-checked'),
      labelColor: label ? getComputedStyle(label).color : null,
      labelBackground: label ? getComputedStyle(label).backgroundColor : null,
      knobColor: knob ? getComputedStyle(knob).backgroundColor : null,
      paths
    };
  });
  if (cashFlowTheme.checked !== 'true' || cashFlowTheme.labelColor !== 'rgb(167, 156, 132)' || cashFlowTheme.labelBackground !== 'rgba(0, 0, 0, 0)' || cashFlowTheme.knobColor !== 'rgb(177, 132, 92)' || cashFlowTheme.paths.length !== 10) {
    throw new Error(`Cash Flow Graphite Aubergine contract drifted: ${JSON.stringify(cashFlowTheme)}`);
  }
  await stableClick('.htab[data-sub-target="goals"]');
  await page.waitForFunction(() => document.querySelector('.page[data-page="net-worth"].on .gh-page'), {
    timeout: 10000
  });
  await stableClick('[data-goal-chip]');
  await page.waitForFunction(() => document.querySelector('.gh-rail .gh-preset'), {
    timeout: 10000
  });
  const goalEditor = await stableEvaluate('read Goals editor timing controls', () => {
    const presets = [...document.querySelectorAll('.gh-rail .gh-preset')];
    return {
      count: presets.length,
      clipped: presets.filter(preset => preset.scrollHeight > preset.clientHeight + 1 || preset.scrollWidth > preset.clientWidth + 1).map(preset => ({
        text: preset.textContent.trim(),
        scrollHeight: preset.scrollHeight,
        clientHeight: preset.clientHeight,
        scrollWidth: preset.scrollWidth,
        clientWidth: preset.clientWidth
      })),
      radii: presets.map(preset => parseFloat(getComputedStyle(preset).borderRadius))
    };
  });
  if (goalEditor.count !== 4 || goalEditor.clipped.length || goalEditor.radii.some(radius => !Number.isFinite(radius) || radius < 4)) {
    throw new Error(`Goals timing controls are clipped or square: ${JSON.stringify(goalEditor)}`);
  }
  await stableClick('.gh-rail__close');
  await page.waitForFunction(() => !document.querySelector('.gh-rail'), {
    timeout: 10000
  });
  await stableClick('.htab[data-page="household"]');
  await goToWizardStep(page, 'net-worth');
  const netWorthLayout = await stableEvaluate('read Net Worth entry layout', () => {
    const rail = document.querySelector('.nw-rail');
    const primary = rail?.querySelector('.nw-primary-button');
    return {
      summaryRails: document.querySelectorAll('.nw-rail').length,
      footers: document.querySelectorAll('.nw-entry-footer').length,
      railRadius: rail ? parseFloat(getComputedStyle(rail).borderRadius) : null,
      primaryRadius: primary ? parseFloat(getComputedStyle(primary).borderRadius) : null,
      gridWidth: document.querySelector('.nw-grid-region')?.getBoundingClientRect().width ?? 0,
      viewWidth: document.querySelector('.nw-entry-view')?.getBoundingClientRect().width ?? 0
    };
  });
  if (netWorthLayout.summaryRails !== 1 || netWorthLayout.footers !== 0 || !Number.isFinite(netWorthLayout.railRadius) || netWorthLayout.railRadius < 4 || !Number.isFinite(netWorthLayout.primaryRadius) || netWorthLayout.primaryRadius < 4 || Math.abs(netWorthLayout.gridWidth - netWorthLayout.viewWidth) > 1) {
    throw new Error(`Net Worth summary rail drifted: ${JSON.stringify(netWorthLayout)}`);
  }
  await goToWizardStep(page, 'tax');
  const taxStack = await stableEvaluate('read Tax profile and IRMAA inputs', () => {
    const boxes = [...document.querySelectorAll('[data-hh-wizard-screen="tax"] [data-tax-summary-box]')];
    const rects = boxes.map(box => box.getBoundingClientRect());
    const controls = [...document.querySelectorAll('[data-hh-wizard-screen="tax"] [data-tax-summary-box] :is(select, .hh-tax-amount)')];
    return {
      count: boxes.length,
      keys: boxes.map(box => box.dataset.taxSummaryBox),
      filingControls: document.querySelectorAll('[data-hh-wizard-screen="tax"] [data-tax-field^="irmaa.lookback."][data-tax-field$=".filingStatus"]').length,
      controlCount: controls.length,
      wrapperRadii: boxes.map(box => parseFloat(getComputedStyle(box).borderRadius)),
      controlRadii: controls.map(control => parseFloat(getComputedStyle(control).borderRadius)),
      topRowAligned: rects.length >= 3 && rects.slice(0, 3).every(rect => Math.abs(rect.top - rects[0].top) <= 1),
      lookbackAligned: rects.length >= 5 && Math.abs(rects[3].left - rects[4].left) <= 1 && Math.abs(rects[3].width - rects[4].width) <= 1,
      lookbackStacked: rects.length >= 5 && rects[4].top >= rects[3].bottom - 1,
      taxableCompanions: document.querySelectorAll('[data-tax-field="income.taxableIra"], [data-tax-field="income.taxablePensions"]').length,
      socialSecuritySource: [...document.querySelectorAll('.hh-tax-subsection h3')].some(heading => heading.textContent.trim() === 'Social Security source')
    };
  });
  if (taxStack.count !== 5 || JSON.stringify(taxStack.keys) !== JSON.stringify(['tax-year', 'filing-status', 'deduction-method', 'irmaa-2024', 'irmaa-2025']) || taxStack.filingControls !== 0 || taxStack.controlCount !== 4 || !taxStack.topRowAligned || !taxStack.lookbackAligned || !taxStack.lookbackStacked || taxStack.taxableCompanions !== 0 || !taxStack.socialSecuritySource || taxStack.wrapperRadii.some(radius => !Number.isFinite(radius) || radius !== 0) || taxStack.controlRadii.some(radius => !Number.isFinite(radius) || radius < 4)) {
    throw new Error(`Tax profile and IRMAA layout drifted: ${JSON.stringify(taxStack)}`);
  }
  await page.setViewport({
    width: 760,
    height: 1600,
    deviceScaleFactor: 1
  });
  for (const contract of [{
    page: 'net-worth',
    ready: '.gh-page'
  }, {
    page: 'tax-buckets',
    ready: '[data-taw-root][aria-busy="false"]'
  }, {
    page: 'sequencing',
    ready: '#seq-prints'
  }, {
    page: 'household',
    ready: '[data-wizard-ready="true"]'
  }]) {
    await stableClick(`.htab[data-page="${contract.page}"]`);
    await page.waitForFunction(({
      pageName,
      selector
    }) => !!document.querySelector(`.page[data-page="${pageName}"].on ${selector}`), {
      timeout: 10000
    }, {
      pageName: contract.page,
      selector: contract.ready
    });
    const width = await stableEvaluate(`read ${contract.page} mobile width`, () => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    if (width.scrollWidth > width.clientWidth) {
      throw new Error(`${contract.page} overflows the 760px viewport: ${JSON.stringify(width)}`);
    }
  }
}
export async function verifyHeader({
  stableClick,
  page
}) {
  await stableClick('button[data-page="scenarios"]');
  await page.waitForFunction(() => document.querySelector('.page[data-page="scenarios"].on'), {
    timeout: 8000
  });
  const hdr = await page.evaluate(() => {
    const el = document.querySelector('.hdr');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const logo = document.querySelector('.hdr__logo img, .brand-logo');
    const tab = document.querySelector('.htab.on');
    const tabAfter = tab ? getComputedStyle(tab, '::after') : null;
    return {
      height: cs.height,
      bg: cs.backgroundColor,
      headerBorderBottom: getComputedStyle(document.querySelector('.hdr__bar')).borderBottomWidth,
      logo: logo?.getAttribute('src') || '',
      logoH: logo ? getComputedStyle(logo).height : '',
      clusterHidden: document.querySelector('.cluster')?.hidden === true,
      tabAfterBg: tabAfter?.backgroundColor || ''
    };
  });
  if (!hdr) throw new Error('Header element missing');
  if (hdr.height !== '68px') throw new Error(`Header height must be 68px, got ${hdr.height}`);
  if (hdr.headerBorderBottom !== '1px') throw new Error(`Header must have 1px bottom hairline, got ${hdr.headerBorderBottom}`);
  if (!hdr.logo.includes('parallax-logo.png')) throw new Error(`Header logo must use parallax-logo.png, got ${hdr.logo}`);
  if (hdr.logoH !== '58px') throw new Error(`Logo must be 58px tall, got ${hdr.logoH}`);
  if (hdr.bg !== 'rgb(24, 25, 24)') throw new Error(`Header must use the graphite page surface, got ${hdr.bg}`);
  if (!hdr.clusterHidden) throw new Error('Header status and Run controls must remain hidden from the product UI');
  if (hdr.tabAfterBg !== 'rgb(177, 132, 92)') throw new Error(`Active tab underline must use the copper accent: ${hdr.tabAfterBg}`);
}
export async function verifyPageBackgrounds({
  stableEvaluate,
  stableClick,
  page,
  SKIP_SEQUENCING
}) {
  const GRAPHITE = 'rgb(24, 25, 24)';
  const bgOf = selector => stableEvaluate(`read ${selector} background`, s => {
    const el = document.querySelector(s);
    return el ? getComputedStyle(el).backgroundColor : '(no element)';
  }, selector);
  await stableClick('button[data-page="scenarios"]');
  await page.waitForFunction(() => document.querySelector('.page[data-page="scenarios"].on'), {
    timeout: 8000
  });
  const scnBg = await bgOf('.page[data-page="scenarios"]');
  await stableClick('.htab[data-sub-target="goals"]');
  await page.waitForFunction(() => document.querySelector('.page[data-page="net-worth"].on') && document.querySelector('#np-content .gh-card'), {
    timeout: 8000
  });
  const goalsBg = await bgOf('.page[data-page="net-worth"]');
  let seqBg = null;
  if (!SKIP_SEQUENCING) {
    await stableClick('button[data-page="sequencing"]');
    await page.waitForFunction(() => document.querySelector('.page[data-page="sequencing"].on'), {
      timeout: 8000
    });
    seqBg = await bgOf('.page[data-page="sequencing"]');
  }
  await stableClick('.htab[data-page="household"]');
  await page.waitForFunction(() => document.querySelector('.page[data-page="household"].on') && document.querySelector('[data-hh-wizard-root]'), {
    timeout: 8000
  });
  const hhBg = await bgOf('.page[data-page="household"]');
  const surfaces = [['scenarios', scnBg], ['goals', goalsBg], ['household', hhBg]];
  if (seqBg !== null) surfaces.splice(2, 0, ['sequencing', seqBg]);
  for (const [name, bg] of surfaces) {
    if (bg !== GRAPHITE) throw new Error(`${name} page lost the shared graphite background: ${bg}`);
  }
}
