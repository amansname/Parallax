import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDefaultTaxContext, runClient1040Intake } from '../annual1040.js';
import { LINE_STATUS } from '../core/form1040Lines.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'fixtures', 'annual', 'annual-08-authoritative-2025-mfj.json');

test('authoritative benchmark: redacted 2025 MFJ line24 within tolerance', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const context = buildDefaultTaxContext({ scenarioId: fixture.id, taxYear: fixture.taxYear });
  const { annual1040Result, result, audits } = runClient1040Intake(fixture, context);

  assert.strictEqual(annual1040Result.federalSummary.taxTotalScope, 'FULL_1040');
  assert.strictEqual(result.form1040.line7a.value, -3000);
  assert.strictEqual(result.form1040.line7a.ruleId, 'FED_SCHEDULE_D_CLASSIFICATION');
  assert.strictEqual(annual1040Result.lines.line15.value, 80328);
  assert.strictEqual(annual1040Result.lines.line16.value, 8759.4);
  assert.strictEqual(result.form1040.line23.value, 1571);
  assert.strictEqual(result.form1040.line23.status, LINE_STATUS.CALCULATED);
  assert.strictEqual(
    result.form1040.line23.ruleId,
    'FED_SELF_EMPLOYMENT_TAX+SCHEDULE_2_SUPPLIED_TAXES'
  );
  assert.ok(audits.some((audit) => (
    audit.ruleId === 'FED_SELF_EMPLOYMENT_TAX'
    && audit.calculationSteps.find(
      step => step.scheduleSELine === 12
    )?.tax === fixture.sourceEvidence.scheduleSE.line12
  )));
  assert.strictEqual(annual1040Result.lines.line24.value, 10330.4);
  assert.strictEqual(annual1040Result.reconciliation.theirLine24, 10331);
  assert.strictEqual(annual1040Result.reconciliation.delta, -0.6);
  assert.strictEqual(annual1040Result.reconciliation.withinTolerance, true);
});
