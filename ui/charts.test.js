import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHART_LAYOUT } from './chartLayout.js';
import { axes } from './charts.js';

test('Sequencing axes use the standalone plot geometry and five-year age cadence', () => {
  const html = axes(1480, 398, 65, 91, 10_000_000, {
    layout: CHART_LAYOUT.scenarioPath,
    fmtM: value => `$${value}`,
    grid: 'var(--grid)',
    axisInk: 'rgba(127,119,114,.72)',
  });

  assert.deepEqual(CHART_LAYOUT.scenarioPath, {
    padLeft: 94,
    padRight: 30,
    padTop: 16,
    padBottom: 38,
  });
  assert.match(html, /<text x="76" y="21" fill="rgba\(127,119,114,.72\)" font-size="13"/);
  assert.match(html, /y="386"[^>]*font-size="13"[^>]*>Age 65<\/text>/);
  assert.match(html, />Age 70<\/text>/);
  assert.match(html, />Age 75<\/text>/);
  assert.match(html, />Age 80<\/text>/);
  assert.match(html, />Age 85<\/text>/);
  assert.match(html, />Age 90<\/text>/);
  assert.match(html, />Age 91<\/text>/);
  assert.doesNotMatch(html, />Age 81<\/text>/);
});
