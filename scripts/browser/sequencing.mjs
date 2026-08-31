// Existing browser assertions; run by scripts/verify.mjs in campaign order.
import { join } from 'node:path';
export async function verifySequencingChips({
  page,
  errs,
  OUT
}) {
  await page.click('button[data-page="sequencing"]');
  await page.waitForFunction(() => document.querySelector('.page.on')?.dataset.page === 'sequencing', {
    timeout: 8000
  });
  await page.evaluate(() => document.querySelectorAll('.seq-chip').forEach(c => {
    if (!c.classList.contains('on')) c.click();
  }));
  try {
    await page.waitForFunction(() => document.querySelectorAll('#seq-svg path').length > 4, {
      timeout: 15000
    });
  } catch (error) {
    const state = await page.evaluate(() => ({
      paths: document.querySelectorAll('#seq-svg path').length,
      chips: document.querySelectorAll('.seq-chip').length,
      activeChips: document.querySelectorAll('.seq-chip.on').length,
      prints: document.querySelectorAll('.seq-print').length
    }));
    throw new Error(`${error.message}; state=${JSON.stringify(state)}; browser=${JSON.stringify(errs.slice(-5))}`);
  }
  const el = await page.$('.seq-chart');
  const chartContract = await page.evaluate(() => {
    const svg = document.querySelector('#seq-svg');
    const ageLabels = [...svg.querySelectorAll('text')].filter(label => label.textContent.startsWith('Age '));
    const valueLabels = [...svg.querySelectorAll('text')].filter(label => label.textContent.startsWith('$'));
    return {
      viewBox: svg.getAttribute('viewBox'),
      width: svg.getBoundingClientRect().width,
      height: svg.getBoundingClientRect().height,
      ages: ageLabels.map(label => label.textContent.trim()),
      ageY: ageLabels.map(label => Number(label.getAttribute('y'))),
      ageSize: ageLabels.map(label => Number(label.getAttribute('font-size'))),
      fills: [...ageLabels, ...valueLabels].map(label => label.getAttribute('fill')),
      valueX: valueLabels.map(label => Number(label.getAttribute('x'))),
      valueSize: valueLabels.map(label => Number(label.getAttribute('font-size')))
    };
  });
  if (chartContract.viewBox !== '0 0 1480 398' || Math.abs(chartContract.width - 1470) > 1 || Math.abs(chartContract.height - 398) > 1 || !chartContract.ages.includes('Age 80') || chartContract.ages.includes('Age 81') || chartContract.ageY.some(value => value !== 386) || chartContract.ageSize.some(value => value !== 13) || chartContract.valueX.some(value => value !== 76) || chartContract.valueSize.some(value => value !== 13) || chartContract.fills.some(value => value !== 'rgba(127,119,114,.72)')) {
    throw new Error(`Sequencing reference geometry drifted: ${JSON.stringify(chartContract)}`);
  }
  await el.screenshot({
    path: join(OUT, '05-sequencing.png')
  });
}
export async function verifyNoDeferredPlayback({
  page,
  OUT
}) {
  const playbackSelectors = await page.evaluate(() => ({
    panel: Boolean(document.querySelector('#playback-panel')),
    verdict: Boolean(document.querySelector('#pb-verdict')),
    yearPicker: Boolean(document.querySelector('[data-pb-year]')),
    detail: Boolean(document.querySelector('#pb-detail-btn'))
  }));
  if (Object.values(playbackSelectors).some(Boolean)) {
    throw new Error(`deferred Playback rendered unexpectedly: ${JSON.stringify(playbackSelectors)}`);
  }
  await page.screenshot({
    path: join(OUT, '06-sequencing-full.png'),
    fullPage: true
  });
}
