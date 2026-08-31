// Wizard browser contract: capture.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WIZARD_STEP_IDS } from './selectors.mjs';
import { requireCondition } from './assertions.mjs';
import { waitForWizard, openWizard, goToWizardStep, clickWizardAction, openNetWorthCategory } from './actions.mjs';
export async function settleWizardCapture(page) {
  await waitForWizard(page);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    if (!document.querySelector('#wizard-capture-freeze')) {
      const style = document.createElement('style');
      style.id = 'wizard-capture-freeze';
      style.textContent = `
        [data-hh-wizard-root],
        [data-hh-wizard-root] *,
        [data-hh-wizard-root] *::before,
        [data-hh-wizard-root] *::after {
          animation: none !important;
          caret-color: transparent !important;
          transition: none !important;
        }
      `;
      document.head.append(style);
    }
  });
  await page.waitForFunction(() => !document.fonts || document.fonts.status === 'loaded', {
    timeout: 8000
  });
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}
async function enableFullPageWizardCapture(page) {
  await page.evaluate(() => {
    let style = document.querySelector('#wizard-fullpage-capture');
    if (!style) {
      style = document.createElement('style');
      style.id = 'wizard-fullpage-capture';
      document.head.append(style);
    }
    style.textContent = `
      html,
      body {
        height: auto !important;
        min-height: 100% !important;
        overflow: visible !important;
      }
      .wrap {
        height: auto !important;
        min-height: 100vh !important;
        overflow: visible !important;
      }
      .page[data-page="household"].on {
        flex: none !important;
        height: auto !important;
        min-height: 100vh !important;
        overflow: visible !important;
      }
      .page[data-page="household"] .hh-stage {
        height: auto !important;
        min-height: 100vh !important;
        overflow: visible !important;
      }
      .page[data-page="household"] .hh-wizard {
        height: auto !important;
        min-height: 0 !important;
        overflow: visible !important;
      }
      .page[data-page="household"] .hh-wiz-workspace {
        flex: none !important;
        height: auto !important;
        overflow: visible !important;
      }
      .page[data-page="household"] .hh-content {
        min-height: 0 !important;
      }
    `;
  });
  await settleWizardCapture(page);
}
function pngDimensions(path) {
  const bytes = readFileSync(path);
  requireCondition(bytes.length >= 24 && bytes.toString('ascii', 1, 4) === 'PNG', `${path} is not a readable PNG`);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20)
  };
}
async function captureFullWizardArtifact(page, path) {
  await enableFullPageWizardCapture(page);
  const metrics = await page.evaluate(() => {
    const workspace = document.querySelector('.hh-wiz-workspace');
    const footer = document.querySelector('[data-hh-wizard-footer]');
    const footerRect = footer?.getBoundingClientRect();
    return {
      documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
      workspaceClientHeight: workspace?.clientHeight ?? null,
      workspaceScrollHeight: workspace?.scrollHeight ?? null,
      workspaceOverflow: workspace ? getComputedStyle(workspace).overflowY : null,
      footerBottom: footerRect?.bottom ?? null
    };
  });
  requireCondition(metrics.workspaceOverflow === 'visible' && metrics.workspaceScrollHeight <= metrics.workspaceClientHeight + 1 && metrics.footerBottom <= metrics.documentHeight + 1, `Wizard full-page capture is clipped: ${JSON.stringify(metrics)}`);
  await page.screenshot({
    path,
    fullPage: true
  });
  const image = pngDimensions(path);
  requireCondition(image.height >= metrics.documentHeight - 1, `Wizard PNG height ${image.height} misses document height ${metrics.documentHeight}`);
  return {
    image,
    metrics
  };
}
export async function captureWizardScreens(page, {
  outDir,
  prefix = 'wizard'
}) {
  requireCondition(outDir, 'captureWizardScreens requires outDir');
  mkdirSync(outDir, {
    recursive: true
  });
  await openWizard(page);
  const artifacts = [];
  await page.setViewport({
    width: 1440,
    height: 900,
    deviceScaleFactor: 1
  });
  for (const step of WIZARD_STEP_IDS) {
    await goToWizardStep(page, step);
    await settleWizardCapture(page);
    const path = join(outDir, `${prefix}-${step}.png`);
    await captureFullWizardArtifact(page, path);
    artifacts.push({
      label: `${step} · desktop`,
      path,
      step,
      viewport: 'desktop'
    });
    if (step === 'net-worth') {
      await openNetWorthCategory(page, 'bank');
      await settleWizardCapture(page);
      const panelPath = join(outDir, `${prefix}-${step}-bank-panel.png`);
      await captureFullWizardArtifact(page, panelPath);
      artifacts.push({
        label: 'net worth bank panel',
        path: panelPath,
        step,
        viewport: 'desktop'
      });
      await clickWizardAction(page, '[data-net-worth-overlay] .nw-panel-close');
    }
  }
  await page.setViewport({
    width: 390,
    height: 844,
    deviceScaleFactor: 1
  });
  for (const step of WIZARD_STEP_IDS) {
    await goToWizardStep(page, step);
    await settleWizardCapture(page);
    const path = join(outDir, `${prefix}-${step}-mobile.png`);
    await captureFullWizardArtifact(page, path);
    artifacts.push({
      label: `${step} · mobile`,
      path,
      step,
      viewport: 'mobile'
    });
  }
  await page.setViewport({
    width: 1440,
    height: 900,
    deviceScaleFactor: 1
  });
  return artifacts;
}
