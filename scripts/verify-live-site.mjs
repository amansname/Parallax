import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MANIFEST_FILE,
  SITE_METADATA_FILE,
  sha256,
  verifyArtifactBundle,
} from './site-integrity-lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_ARTIFACT_ROOT = join(ROOT, '.parallax-artifact');

function parseArguments(argv){
  const options = {
    artifactRoot: DEFAULT_ARTIFACT_ROOT,
    baseUrl: null,
    timeoutMs: 10 * 60 * 1000,
    intervalMs: 5000,
  };
  for(let index = 0; index < argv.length; index += 1){
    const flag = argv[index];
    const value = argv[++index];
    if(value == null) throw new Error(`${flag} requires a value`);
    if(flag === '--artifact-root') options.artifactRoot = resolve(value);
    else if(flag === '--base-url') options.baseUrl = value;
    else if(flag === '--timeout-ms') options.timeoutMs = Number(value);
    else if(flag === '--interval-ms') options.intervalMs = Number(value);
    else throw new Error(`unknown verify-live-site argument: ${flag}`);
  }
  if(!options.baseUrl) throw new Error('--base-url is required');
  if(!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) throw new Error('--timeout-ms must be a non-negative number');
  if(!Number.isFinite(options.intervalMs) || options.intervalMs < 100) throw new Error('--interval-ms must be at least 100');
  options.baseUrl = new URL(options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`);
  return options;
}

function nonce(){
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

function cacheBustedUrl(baseUrl, path, artifactId){
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = new URL(encodedPath, baseUrl);
  url.searchParams.set('artifact', artifactId);
  url.searchParams.set('verification', nonce());
  return url;
}

async function fetchBytes(url){
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' },
  });
  if(!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function waitForArtifact(baseUrl, artifactId, timeoutMs, intervalMs){
  const deadline = Date.now() + timeoutMs;
  let lastObservation = 'no response';
  while(true){
    try{
      const bytes = await fetchBytes(cacheBustedUrl(baseUrl, SITE_METADATA_FILE, artifactId));
      const metadata = JSON.parse(bytes.toString('utf8'));
      lastObservation = `artifact ${metadata.artifactId || 'missing'}`;
      if(metadata.schemaVersion === 1 && metadata.artifactId === artifactId) return;
    }catch(error){
      lastObservation = error instanceof Error ? error.message : String(error);
    }
    if(Date.now() >= deadline){
      throw new Error(`live site did not expose artifact ${artifactId} before timeout; last observation: ${lastObservation}`);
    }
    await new Promise(resolveWait => setTimeout(resolveWait, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
}

export async function verifyLiveSite(options){
  const { manifest, siteRoot } = verifyArtifactBundle(options.artifactRoot);
  await waitForArtifact(options.baseUrl, manifest.artifactId, options.timeoutMs, options.intervalMs);

  const expectedManifestBytes = readFileSync(join(siteRoot, MANIFEST_FILE));
  const liveManifestBytes = await fetchBytes(cacheBustedUrl(options.baseUrl, MANIFEST_FILE, manifest.artifactId));
  if(!expectedManifestBytes.equals(liveManifestBytes)){
    throw new Error(`live ${MANIFEST_FILE} differs from the deployed artifact manifest`);
  }

  for(const file of manifest.files){
    const liveBytes = await fetchBytes(cacheBustedUrl(options.baseUrl, file.path, manifest.artifactId));
    if(liveBytes.byteLength !== file.bytes){
      throw new Error(`live ${file.path} byte count differs: expected ${file.bytes}, got ${liveBytes.byteLength}`);
    }
    const liveHash = sha256(liveBytes);
    if(liveHash !== file.sha256){
      throw new Error(`live ${file.path} hash differs: expected ${file.sha256}, got ${liveHash}`);
    }
  }

  return manifest;
}

try{
  const options = parseArguments(process.argv.slice(2));
  const manifest = await verifyLiveSite(options);
  console.log(`Verified live Parallax artifact ${manifest.artifactId} byte-for-byte (${manifest.files.length} files)`);
}catch(error){
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
