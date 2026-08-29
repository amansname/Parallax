import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_COMMIT_IDENTITY = Object.freeze({
  name: 'parallax-pr-author-amans[bot]',
  email: '315909848+parallax-pr-author-amans[bot]@users.noreply.github.com',
});

export function validateCandidateCommitRecords(records, requiredIdentity = REQUIRED_COMMIT_IDENTITY){
  const failures = [];
  if(!Array.isArray(records) || !records.length){
    return ['candidate range must contain at least one commit'];
  }

  for(const record of records){
    const sha = record?.sha || 'unknown commit';
    if(record?.authorName !== requiredIdentity.name || record?.authorEmail !== requiredIdentity.email){
      failures.push(`${sha} must use the Parallax bot as Git author`);
    }
    if(record?.committerName !== requiredIdentity.name || record?.committerEmail !== requiredIdentity.email){
      failures.push(`${sha} must use the Parallax bot as Git committer`);
    }
  }
  return failures;
}

export function readCandidateCommitRecords(baseSha, headSha){
  if(!/^[0-9a-f]{40}$/i.test(baseSha || '') || !/^[0-9a-f]{40}$/i.test(headSha || '')){
    throw new Error('PARALLAX_BASE_SHA and PARALLAX_HEAD_SHA must be full commit SHAs');
  }
  const output = execFileSync('git', [
    'log',
    '--format=%H%x09%an%x09%ae%x09%cn%x09%ce',
    `${baseSha}..${headSha}`,
  ], { encoding: 'utf8' });
  return output.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const [sha, authorName, authorEmail, committerName, committerEmail] = line.split('\t');
    return { sha, authorName, authorEmail, committerName, committerEmail };
  });
}

function run(){
  const records = readCandidateCommitRecords(
    process.env.PARALLAX_BASE_SHA,
    process.env.PARALLAX_HEAD_SHA,
  );
  const failures = validateCandidateCommitRecords(records);
  if(failures.length){
    console.error('Candidate commit authorship validation failed:');
    for(const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`Candidate commit authorship passed (${records.length} bot-authored commit${records.length === 1 ? '' : 's'}).`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if(invokedPath === fileURLToPath(import.meta.url)) run();
