import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyArtifactBundle } from './site-integrity-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function parseArguments(argv){
  let artifactRoot = resolve(ROOT, '.parallax-artifact');
  for(let index = 0; index < argv.length; index += 1){
    if(argv[index] !== '--artifact-root') throw new Error(`unknown verify-site-artifact argument: ${argv[index]}`);
    if(!argv[index + 1]) throw new Error('--artifact-root requires a value');
    artifactRoot = resolve(argv[++index]);
  }
  return artifactRoot;
}

try{
  const artifactRoot = parseArguments(process.argv.slice(2));
  const { manifest, attestation } = verifyArtifactBundle(artifactRoot);
  console.log(`Verified Parallax site artifact ${manifest.artifactId} (${manifest.files.length} files)`);
  console.log(`Source commit: ${attestation.sourceCommit}`);
  console.log(`Source tree: ${manifest.sourceTree}`);
}catch(error){
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
