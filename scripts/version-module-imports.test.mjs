import test from 'node:test';
import assert from 'node:assert/strict';
import { versionModuleImports } from './version-module-imports.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { bindArtifactId, isDeployableSourcePath } from './site-integrity-lib.mjs';

const id = 'a'.repeat(64);
const modules = ['engine.js', 'src/worker.js', 'src/other.js'];
const transform = source => versionModuleImports(Buffer.from(source), 'src/worker.js', id, modules).toString();

test('worker static imports, re-exports and literal dynamic imports bind to the same artifact', () => {
  assert.equal(transform("import {run} from '../engine.js'; export * from './other.js'; export {run} from '../engine.js'; const next=import('./other.js');"),
    `import {run} from "../engine.js?v=${id}"; export * from "./other.js?v=${id}"; export {run} from "../engine.js?v=${id}"; const next=import("./other.js?v=${id}");`);
});

test('comments and ordinary strings are not interpreted as import declarations', () => {
  const source = "// import './missing.js';\nconst sample = \"import './missing.js'\"; export {sample};";
  assert.equal(transform(source), source);
});

test('module queries and fragments survive version binding', () => {
  assert.equal(transform("import './other.js?mode=worker#part';"), `import "./other.js?mode=worker&v=${id}#part";`);
  assert.equal(transform(`import './other.js?v=${id}';`), `import "./other.js?v=${id}";`);
});

test('missing modules, mixed artifact IDs and invalid JavaScript fail the artifact build', () => {
  assert.throws(() => transform("import '../missing.js';"), /non-artifact module/);
  assert.throws(() => transform("import './other.js?v=old';"), /another artifact version/);
  assert.throws(() => transform('import {'), /Cannot parse artifact module/);
});

test('the complete production module graph can be parsed and versioned without changing source files', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const scan = directory => readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? scan(path) : [path];
  });
  const paths = ['engine.js', ...scan('src'), ...scan('ui')].filter(path => path.endsWith('.js') && isDeployableSourcePath(path));
  assert.ok(paths.includes('src/planning/scenarioWorker.js'));
  for (const path of paths) {
    const output = versionModuleImports(bindArtifactId(readFileSync(resolve(root, path)), id), path, id, paths);
    assert.ok(output.length > 0, path);
  }
});
