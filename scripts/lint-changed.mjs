import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JAVASCRIPT_PATH = /\.(?:c|m)?js$/i;

export function parseArguments(args){
  const options = {};
  for(let index = 0; index < args.length; index += 2){
    const flag = args[index];
    const value = args[index + 1];
    if(!['--base', '--head'].includes(flag) || !value){
      throw new Error('Usage: node scripts/lint-changed.mjs [--base <revision> --head <revision>]');
    }
    const key = flag.slice(2);
    if(options[key]) throw new Error(`${flag} may be supplied only once`);
    options[key] = value;
  }
  return options;
}

export function parseChangedJavaScriptPaths(output){
  return String(output || '')
    .split('\0')
    .filter(Boolean)
    .filter(path => JAVASCRIPT_PATH.test(path))
    .sort((left, right) => left.localeCompare(right));
}

export function changedPathArguments(baseSha, headSha){
  for(const [label, value] of [['base', baseSha], ['head', headSha]]){
    if(!/^[0-9a-f]{40}$/i.test(value)){
      throw new Error(`${label} must resolve to a full commit SHA`);
    }
  }
  return [
    'diff',
    '--name-only',
    '--diff-filter=ACMR',
    '-z',
    `${baseSha}...${headSha}`,
    '--',
  ];
}

function runGit(args){
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  if(result.error) throw result.error;
  if(result.status !== 0){
    throw new Error(result.stderr.trim() || `git ${args[0]} exited ${result.status}`);
  }
  return result.stdout;
}

function resolveCommit(revision, label){
  if(typeof revision !== 'string' || !revision.trim() || revision.startsWith('-')){
    throw new Error(`${label} revision is missing or invalid`);
  }
  return runGit(['rev-parse', '--verify', `${revision}^{commit}`]).trim();
}

function main(){
  const options = parseArguments(process.argv.slice(2));
  const baseRevision = options.base || process.env.PARALLAX_BASE_SHA || 'origin/main';
  const headRevision = options.head || process.env.CANDIDATE_SHA || 'HEAD';
  const baseSha = resolveCommit(baseRevision, 'base');
  const headSha = resolveCommit(headRevision, 'head');
  const files = parseChangedJavaScriptPaths(runGit(changedPathArguments(baseSha, headSha)));

  if(!files.length){
    console.log('ESLint changed-file check passed (0 JavaScript files changed).');
    return;
  }

  console.log(`ESLint checking ${files.length} changed JavaScript file${files.length === 1 ? '' : 's'}:`);
  for(const file of files) console.log(`- ${file}`);

  const eslintScript = resolve(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
  const result = spawnSync(process.execPath, [eslintScript, '--', ...files], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });
  if(result.error) throw result.error;
  if(result.signal) throw new Error(`ESLint terminated by ${result.signal}`);
  if(result.status !== 0) process.exitCode = result.status ?? 1;
  else console.log(`ESLint changed-file check passed (${files.length} files).`);
}

if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  try{
    main();
  }catch(error){
    console.error(`ESLint changed-file check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
