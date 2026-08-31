import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function verifyTaxBuckets(ROOT, SKIP_SEQUENCING) {
  const read = path => existsSync(path) ? readFileSync(path, 'utf8') : '';
  const fails = [];
  const ok = (condition, message) => {
    if (!condition) fails.push(message);
  };
  const html = read(join(ROOT, 'index.html'));
  const main = read(join(ROOT, 'src', 'main.js'));
  const view = read(join(ROOT, 'ui', 'taxBuckets.js'));
  const columns = read(join(ROOT, 'ui', 'taxAwareWithdrawalColumns.js'));
  const withdrawalDom = read(join(ROOT, 'ui', 'taxAwareWithdrawalDom.js'));
  const css = read(join(ROOT, 'styles', 'tax-buckets.css'));
  ok(html.includes('styles/tax-buckets.css?v=__PARALLAX_ARTIFACT_ID__'), 'Tax Buckets stylesheet is not artifact-bound');
  ok(html.includes('styles/tax-aware-withdrawal.css?v=__PARALLAX_ARTIFACT_ID__'), 'Tax-Aware Withdrawal stylesheet is not artifact-bound');
  ok(SKIP_SEQUENCING ? /data-page="scenarios"[\s\S]*data-page="tax-buckets"/.test(html) : /data-page="scenarios"[\s\S]*data-page="tax-buckets"[\s\S]*data-page="sequencing"/.test(html), SKIP_SEQUENCING ? 'Tax Buckets must follow Scenarios' : 'Tax Buckets must sit between Scenarios and Sequencing');
  ok(/<section class="page" data-page="tax-buckets">[\s\S]*id="tax-buckets-view"/.test(html), 'Tax Buckets page mount is missing');
  ok(/getPlan:\(\)=>plan/.test(main), 'Tax Buckets must read household plan without mutating it');
  ok(/createTaxAwareWithdrawalController/.test(view), 'Withdrawal planner controller is not wired');
  ok(/taxEngineAdapter/.test(read(join(ROOT, 'src', 'planning', 'taxBuckets', 'taxEngineAdapter.js'))), 'Tax engine adapter seam is missing');
  ok(/createTaxBucketsController/.test(main), 'Tax Buckets view controller is not wired');
  ok(!/(?:engine\.js|src\/tax\/|annual1040|ordinaryIncomeTax)/.test(view), 'Tax Buckets UI must not own engine or federal-tax math');
  ok(/thresholdTaxDollars/.test(columns), 'Withdrawal Planner columns must display tax-engine dollar outputs');
  ok(!/label:\s*['"](?:15|20|50|85)%['"]/.test(columns), 'Withdrawal Planner UI must not hardcode federal tax-rate labels');
  ok(!/data-taw-(?:year|fs|mfs|law)/.test(withdrawalDom), 'Withdrawal Planner must use canonical household tax facts without page-local overrides');
  ok(!/Shapley|Attribution unavailable|Conversion and QCD held fixed/.test(withdrawalDom), 'Withdrawal Planner must not render calculation methodology copy');
  ok(!/replay/i.test(view), 'production Tax Buckets UI must not ship a replay control');
  ok(/#tax-buckets-view/.test(css), 'Tax Buckets page mount styling is missing');
  if (fails.length) {
    console.error('FAIL Tax Buckets contract:');
    fails.forEach(failure => console.error('  - ' + failure));
    process.exit(1);
  }
  console.log('  OK Tax Buckets contract (withdrawal planner tab, adapter seam, page-scoped styles)');
}
