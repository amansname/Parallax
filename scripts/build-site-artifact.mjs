import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MANIFEST_FILE,
  SITE_METADATA_FILE,
  assertContainedPath,
  bindArtifactId,
  computeArtifactId,
  createManifest,
  createSiteMetadata,
  createStableBootstrapHtml,
  isDeployableSourcePath,
  serializeJson,
  sha256,
  toArtifactPath,
  transformApplicationHtml,
  verifyArtifactBundle,
} from './site-integrity-lib.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const ARTIFACT_ROOT = join(ROOT, '.parallax-artifact');
const DEFAULT_SITE_ROOT = join(ARTIFACT_ROOT, 'site');
const EXPECTED_INDEX_TOKEN_COUNT = 10;

function git(args, options = {}){
  const result = spawnSync('git', ['-C', ROOT, ...args], {
    encoding: options.encoding ?? null,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  if(result.status !== 0){
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr;
    throw new Error(`git ${args.join(' ')} failed: ${(stderr || '').trim()}`);
  }
  return result.stdout;
}

export function assertCleanCandidateWorktree(){
  const status = String(git(['status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' }));
  if(status.trim()){
    throw new Error(`Parallax candidate artifact requires a clean worktree. Freeze the candidate commit first.\n${status.trim()}`);
  }
}

function resolveCommit(revision){
  return String(git(['rev-parse', '--verify', `${revision}^{commit}`], { encoding: 'utf8' })).trim();
}

function readCommitEntries(commit){
  const listed = git(['ls-tree', '-r', '-z', '--name-only', commit]);
  const paths = listed.toString('utf8').split('\0').filter(Boolean).map(toArtifactPath);
  const selected = paths.filter(isDeployableSourcePath).sort();
  for(const required of ['engine.js', 'index.html', 'src/main.js']){
    if(!selected.includes(required)) throw new Error(`commit ${commit} is missing required deploy file ${required}`);
  }
  return selected.map(path => ({
    path,
    bytes: git(['cat-file', 'blob', `${commit}:${path}`]),
  }));
}

function parseArguments(argv){
  const options = { commit: 'HEAD', output: DEFAULT_SITE_ROOT };
  for(let index = 0; index < argv.length; index += 1){
    const flag = argv[index];
    if(flag === '--commit') options.commit = argv[++index];
    else if(flag === '--output') options.output = argv[++index];
    else throw new Error(`unknown build-site-artifact argument: ${flag}`);
    if(options[flag === '--commit' ? 'commit' : 'output'] == null){
      throw new Error(`${flag} requires a value`);
    }
  }
  return options;
}

export function buildSiteArtifact({ commit = 'HEAD', output = DEFAULT_SITE_ROOT } = {}){
  const sourceCommit = resolveCommit(commit);
  const sourceTree = String(git(['show', '-s', '--format=%T', sourceCommit], { encoding: 'utf8' })).trim();
  const sourceEntries = readCommitEntries(sourceCommit);
  const artifactId = computeArtifactId(sourceEntries);
  const modulePaths = sourceEntries
    .map(entry => entry.path)
    .filter(path => path.endsWith('.js'));
  const sourceIndex = sourceEntries.find(entry => entry.path === 'index.html');
  const appHtml = transformApplicationHtml(
    sourceIndex.bytes,
    modulePaths,
    artifactId,
    EXPECTED_INDEX_TOKEN_COUNT,
  );

  const artifactEntries = sourceEntries
    .filter(entry => entry.path !== 'index.html')
    .map(entry => ({
      path: entry.path,
      bytes: bindArtifactId(entry.bytes, artifactId),
    }));
  artifactEntries.push(
    { path: '.nojekyll', bytes: Buffer.alloc(0) },
    { path: 'app.html', bytes: appHtml },
    { path: 'index.html', bytes: createStableBootstrapHtml() },
    { path: SITE_METADATA_FILE, bytes: createSiteMetadata(artifactId, sourceTree) },
  );
  artifactEntries.sort((left, right) => left.path.localeCompare(right.path, 'en'));

  const manifest = createManifest(artifactId, sourceTree, artifactEntries);
  const manifestBytes = serializeJson(manifest);
  const siteRoot = assertContainedPath(ARTIFACT_ROOT, resolve(output), 'site artifact output');
  if(siteRoot === resolve(ARTIFACT_ROOT)) throw new Error('site artifact output cannot replace the artifact root');

  rmSync(siteRoot, { recursive: true, force: true });
  mkdirSync(siteRoot, { recursive: true });
  for(const entry of artifactEntries){
    const destination = assertContainedPath(siteRoot, join(siteRoot, entry.path), `artifact file ${entry.path}`);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, entry.bytes);
  }
  writeFileSync(join(siteRoot, MANIFEST_FILE), manifestBytes);

  mkdirSync(ARTIFACT_ROOT, { recursive: true });
  const attestation = {
    schemaVersion: 1,
    sourceCommit,
    sourceTree,
    artifactId,
    manifestSha256: sha256(manifestBytes),
    fileCount: manifest.files.length,
  };
  writeFileSync(join(ARTIFACT_ROOT, 'attestation.json'), serializeJson(attestation));
  verifyArtifactBundle(ARTIFACT_ROOT);

  return {
    root: siteRoot,
    artifactRoot: ARTIFACT_ROOT,
    sourceCommit,
    sourceTree,
    artifactId,
    manifestSha256: attestation.manifestSha256,
    fileCount: manifest.files.length,
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if(invokedPath === fileURLToPath(import.meta.url)){
  try{
    const result = buildSiteArtifact(parseArguments(process.argv.slice(2)));
    console.log(`Built Parallax site artifact ${result.artifactId}`);
    console.log(`Source commit: ${result.sourceCommit}`);
    console.log(`Source tree: ${result.sourceTree}`);
    console.log(`Files: ${result.fileCount}`);
    console.log(`Output: ${result.root}`);
  }catch(error){
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
