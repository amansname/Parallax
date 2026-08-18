import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  IMPORT_MAP_TOKEN,
  MANIFEST_FILE,
  SITE_METADATA_FILE,
  bindArtifactId,
  computeArtifactId,
  createManifest,
  createSiteMetadata,
  createStableBootstrapHtml,
  isDeployableSourcePath,
  serializeJson,
  transformApplicationHtml,
  verifyArtifactDirectory,
} from './site-integrity-lib.mjs';

test('deploy allowlist excludes tests and repository-only files', () => {
  assert.equal(isDeployableSourcePath('index.html'), true);
  assert.equal(isDeployableSourcePath('engine.js'), true);
  assert.equal(isDeployableSourcePath('src/main.js'), true);
  assert.equal(isDeployableSourcePath('ui/household.js'), true);
  assert.equal(isDeployableSourcePath('styles/main.css'), true);
  assert.equal(isDeployableSourcePath('assets/parallax-logo.png'), true);
  assert.equal(isDeployableSourcePath('src/state.test.js'), false);
  assert.equal(isDeployableSourcePath('src/tax/tests/integration.js'), false);
  assert.equal(isDeployableSourcePath('test/fixtures/persisted/clean-state.v1.json'), false);
  assert.equal(isDeployableSourcePath('.github/workflows/test.yml'), false);
  assert.equal(isDeployableSourcePath('docs/EXECUTION-PROTOCOL.md'), false);
});

test('artifact ID is stable across source enumeration order and changes with bytes', () => {
  const left = [
    { path: 'src/main.js', bytes: Buffer.from('main') },
    { path: 'index.html', bytes: Buffer.from('index') },
  ];
  assert.equal(computeArtifactId(left), computeArtifactId([...left].reverse()));
  assert.notEqual(
    computeArtifactId(left),
    computeArtifactId([{ ...left[0], bytes: Buffer.from('changed') }, left[1]]),
  );
});

test('dynamic local asset URLs bind to the same artifact ID', () => {
  const id = 'd'.repeat(64);
  const source = Buffer.from('const icon="asset.svg?v=__PARALLAX_ARTIFACT_ID__";');
  const output = bindArtifactId(source, id).toString('utf8');
  assert.equal(output, `const icon="asset.svg?v=${id}";`);
});

test('application HTML binds every module and entry asset to one artifact ID', () => {
  const id = 'a'.repeat(64);
  const source = Buffer.from(
    `<link href="styles/main.css?v=__PARALLAX_ARTIFACT_ID__">${IMPORT_MAP_TOKEN}`
      + '<script type="module" src="src/main.js?v=__PARALLAX_ARTIFACT_ID__"></script>',
  );
  const output = transformApplicationHtml(source, ['src/main.js', 'ui/view.js'], id, 2).toString('utf8');
  assert.equal(output.includes('__PARALLAX_ARTIFACT_ID__'), false);
  assert.match(output, /"\.\/src\/main\.js":"\.\/src\/main\.js\?v=/);
  assert.match(output, /"\.\/ui\/view\.js":"\.\/ui\/view\.js\?v=/);
  assert.match(output, new RegExp(`expectedArtifactId="${id}"`));
  assert.equal(output.includes("import('./src/main.js?v='+expectedArtifactId)"), true);
});

test('artifact verifier rejects an unmanifested or changed byte', () => {
  const root = mkdtempSync(join(tmpdir(), 'parallax-site-integrity-'));
  try{
    const id = 'b'.repeat(64);
    const sourceTree = 'c'.repeat(40);
    const entries = [
      { path: '.nojekyll', bytes: Buffer.alloc(0) },
      { path: 'app.html', bytes: Buffer.from(`<script src="src/main.js?v=${id}"></script>`) },
      { path: 'index.html', bytes: createStableBootstrapHtml() },
      { path: SITE_METADATA_FILE, bytes: createSiteMetadata(id, sourceTree) },
      { path: 'src/main.js', bytes: Buffer.from('export const ok = true;\n') },
    ];
    for(const entry of entries){
      const path = join(root, entry.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, entry.bytes);
    }
    writeFileSync(join(root, MANIFEST_FILE), serializeJson(createManifest(id, sourceTree, entries)));
    assert.equal(verifyArtifactDirectory(root).artifactId, id);

    writeFileSync(join(root, 'src/main.js'), 'export const ok = false;\n');
    assert.throws(() => verifyArtifactDirectory(root), /byte count differs|hash differs/);
  }finally{
    rmSync(root, { recursive: true, force: true });
  }
});
