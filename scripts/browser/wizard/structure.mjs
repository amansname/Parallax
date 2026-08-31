// Wizard browser contract: structure.
import { join } from 'node:path';
import { WIZARD_STEP_IDS } from './selectors.mjs';
import { requireCondition } from './assertions.mjs';
import { goToWizardStep } from './actions.mjs';
import { settleWizardCapture } from './capture.mjs';
export async function assertFourStepStructure(page) {
  const structure = await page.evaluate(() => {
    const root = document.querySelector('[data-hh-wizard-root]');
    const nav = [...document.querySelectorAll('[data-hh-wizard-nav]')];
    const ids = nav.map(item => item.dataset.hhWizardNav);
    const panels = [...document.querySelectorAll('[data-hh-wizard-screen]')];
    const hookCounts = ids.map(id => ({
      id,
      nav: document.querySelectorAll(`[data-hh-wizard-nav="${id}"]`).length,
      panel: document.querySelectorAll(`[data-hh-wizard-screen="${id}"]`).length
    }));
    const logo = document.querySelector('.brand-logo');
    const importMaps = document.querySelectorAll('script[type="importmap"]');
    if (importMaps.length !== 1) throw new Error('Expected one artifact import map');
    const mainUrl = JSON.parse(importMaps[0].textContent).imports['./src/main.js'];
    if (!mainUrl) throw new Error('Artifact import map is missing src/main.js');
    return {
      ready: root?.dataset.wizardReady,
      busy: root?.getAttribute('aria-busy'),
      ids,
      labels: nav.map(item => item.querySelector('strong')?.textContent.trim() || ''),
      panels: panels.map(item => item.dataset.hhWizardScreen),
      hookCounts,
      logo: {
        src: logo?.getAttribute('src') || '',
        complete: logo?.complete === true,
        naturalWidth: logo?.naturalWidth || 0
      },
      artifactId: new URL(mainUrl, location.href).searchParams.get('v') || ''
    };
  });
  requireCondition(JSON.stringify(structure.ids) === JSON.stringify(WIZARD_STEP_IDS), `Wizard steps drifted: ${JSON.stringify(structure.ids)}`);
  requireCondition(JSON.stringify(structure.labels) === JSON.stringify(['Family', 'Net Worth', 'Tax', 'Summary']), `Wizard labels drifted: ${JSON.stringify(structure.labels)}`);
  requireCondition(structure.hookCounts.every(item => item.nav === 1), `Wizard navigation hooks are not unique: ${JSON.stringify(structure.hookCounts)}`);
  requireCondition(structure.panels.length === 1 && WIZARD_STEP_IDS.includes(structure.panels[0]), `Wizard must render one semantic screen: ${JSON.stringify(structure.panels)}`);
  requireCondition(/^[a-f0-9]{64}$/.test(structure.artifactId) && structure.logo.src === `assets/parallax-logo.png?v=${structure.artifactId}` && structure.logo.complete && structure.logo.naturalWidth > 0, `Canonical logo did not load: ${JSON.stringify(structure.logo)}`);
}
export async function assertViewport(page, viewport, step, outDir, filename) {
  await goToWizardStep(page, step);
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1
  });
  await settleWizardCapture(page);
  const metrics = await page.evaluate(() => {
    const root = document.querySelector('[data-hh-wizard-root]');
    const screen = document.querySelector('[data-hh-wizard-screen]');
    const sidebar = document.querySelector('.hh-sidebar');
    const footer = document.querySelector('[data-hh-wizard-footer]');
    const netWorthNavigation = [...document.querySelectorAll('.nw-rail-actions')];
    const nav = document.querySelector('[data-hh-wizard-nav][aria-current="step"]');
    const header = document.querySelector('.app-header');
    const headerParts = [header, header?.querySelector('.hdr__logo'), header?.querySelector('.hdr__tabs'), header?.querySelector('.hdr__right')].filter(Boolean);
    const rect = root?.getBoundingClientRect();
    const screenRect = screen?.getBoundingClientRect();
    const sidebarRect = sidebar?.getBoundingClientRect();
    const footerRect = footer?.getBoundingClientRect();
    const headerContentBottom = Math.max(0, ...headerParts.map(element => element.getBoundingClientRect().bottom));
    const rendered = (element, elementRect) => {
      if (!element || !elementRect) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && elementRect.width > 0 && elementRect.height > 0;
    };
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
      rootLeft: rect?.left ?? null,
      rootRight: rect?.right ?? null,
      rootTop: rect?.top ?? null,
      headerContentBottom,
      viewportWidth: document.documentElement.clientWidth,
      sidebarVisible: rendered(sidebar, sidebarRect),
      footerVisible: rendered(footer, footerRect),
      netWorthNavigationVisible: netWorthNavigation.some(element => rendered(element, element.getBoundingClientRect())),
      screenVisible: rendered(screen, screenRect),
      step: root?.dataset.wizardStep || '',
      screen: screen?.dataset.hhWizardScreen || '',
      nav: nav?.dataset.hhWizardNav || ''
    };
  });
  requireCondition(metrics.documentOverflow <= 1 && metrics.bodyOverflow <= 1 && metrics.rootLeft >= -1 && metrics.rootRight <= metrics.viewportWidth + 1 && metrics.rootTop >= metrics.headerContentBottom - 1 && metrics.sidebarVisible && (step === 'net-worth' ? metrics.netWorthNavigationVisible : metrics.footerVisible) && metrics.screenVisible && metrics.step === step && metrics.screen === step && metrics.nav === step, `Wizard ${step} fails ${viewport.width}x${viewport.height}: ${JSON.stringify(metrics)}`);
  if (outDir) {
    await page.screenshot({
      path: join(outDir, filename),
      fullPage: true
    });
  }
}
