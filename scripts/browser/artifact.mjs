import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { assertCleanCandidateWorktree, buildSiteArtifact } from '../build-site-artifact.mjs';
import { verifyArtifactBundle } from '../site-integrity-lib.mjs';
function currentCommit(ROOT) {
  const result = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) throw new Error(`could not resolve verifier commit: ${result.stderr?.trim() || 'git failed'}`);
  return result.stdout.trim();
}
export function prepareVerifiedArtifact(ROOT) {
  const configuredRoot = process.env.PARALLAX_ARTIFACT_ROOT;
  if (!configuredRoot) {
    assertCleanCandidateWorktree();
    buildSiteArtifact({
      commit: 'HEAD'
    });
  }
  const artifactRoot = configuredRoot ? resolve(ROOT, configuredRoot) : join(ROOT, '.parallax-artifact');
  const verified = verifyArtifactBundle(artifactRoot);
  const head = currentCommit(ROOT);
  if (verified.attestation.sourceCommit !== head) {
    throw new Error(`browser artifact commit ${verified.attestation.sourceCommit} does not match checked-out candidate ${head}`);
  }
  return verified;
}
