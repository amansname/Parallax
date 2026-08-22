import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

export const ARTIFACT_ID_TOKEN = '__PARALLAX_ARTIFACT_ID__';
export const IMPORT_MAP_TOKEN = '<!-- __PARALLAX_IMPORT_MAP__ -->';
export const MANIFEST_FILE = 'parallax-site-manifest.json';
export const SITE_METADATA_FILE = 'parallax-site.json';
export const ARTIFACT_SCHEMA_VERSION = 1;

const EXACT_DEPLOY_FILES = new Set([
  'engine.js',
  'index.html',
]);

const ALLOWED_EXTENSIONS = new Map([
  ['assets', new Set(['.gif', '.ico', '.jpeg', '.jpg', '.json', '.otf', '.png', '.svg', '.ttf', '.webp', '.woff', '.woff2'])],
  ['src', new Set(['.js', '.json'])],
  ['styles', new Set(['.css', '.ttf'])],
  ['ui', new Set(['.js'])],
]);

const EXCLUDED_PATH_SEGMENTS = new Set([
  '__snapshots__',
  'fixtures',
  'test',
  'tests',
]);

export function sha256(bytes){
  return createHash('sha256').update(bytes).digest('hex');
}

export function toArtifactPath(path){
  return String(path).replaceAll('\\', '/').replace(/^\.\//, '');
}

export function isDeployableSourcePath(candidate){
  const path = toArtifactPath(candidate);
  if(EXACT_DEPLOY_FILES.has(path)) return true;
  if(path.endsWith('.test.js') || path.endsWith('.spec.js')) return false;

  const segments = path.split('/');
  if(segments.some(segment => EXCLUDED_PATH_SEGMENTS.has(segment))) return false;

  const allowedExtensions = ALLOWED_EXTENSIONS.get(segments[0]);
  return Boolean(allowedExtensions?.has(extname(path).toLowerCase()));
}

function comparePath(left, right){
  return left.path.localeCompare(right.path, 'en');
}

export function computeArtifactId(sourceEntries){
  const digest = createHash('sha256');
  for(const entry of [...sourceEntries].sort(comparePath)){
    const path = toArtifactPath(entry.path);
    const bytes = Buffer.from(entry.bytes);
    digest.update(path, 'utf8');
    digest.update('\0');
    digest.update(String(bytes.byteLength), 'utf8');
    digest.update('\0');
    digest.update(sha256(bytes), 'utf8');
    digest.update('\n');
  }
  return digest.digest('hex');
}

export function replaceExactly(source, target, replacement, expectedCount, label){
  const parts = source.split(target);
  const actualCount = parts.length - 1;
  if(actualCount !== expectedCount){
    throw new Error(`${label} expected ${expectedCount} exact replacement(s), found ${actualCount}`);
  }
  return parts.join(replacement);
}

export function bindArtifactId(sourceBytes, artifactId){
  const source = Buffer.from(sourceBytes).toString('utf8');
  if(!source.includes(ARTIFACT_ID_TOKEN)) return Buffer.from(sourceBytes);
  return Buffer.from(source.replaceAll(ARTIFACT_ID_TOKEN, artifactId), 'utf8');
}

export function createImportMap(modulePaths, artifactId){
  const imports = {};
  for(const rawPath of [...modulePaths].map(toArtifactPath).sort()){
    imports[`./${rawPath}`] = `./${rawPath}?v=${artifactId}`;
  }
  return `<script type="importmap">${JSON.stringify({ imports })}</script>`;
}

function createApplicationBootstrap(artifactId){
  return `<script type="module">
const expectedArtifactId=${JSON.stringify(artifactId)};
try{
  const nonce=Date.now().toString(36)+'-'+crypto.getRandomValues(new Uint32Array(2)).join('-');
  const metadataUrl=new URL('parallax-site.json?request='+encodeURIComponent(nonce),location.href);
  const response=await fetch(metadataUrl,{cache:'no-store',credentials:'same-origin'});
  if(!response.ok)throw new Error('site metadata returned '+response.status);
  const metadata=await response.json();
  if(metadata.schemaVersion!==1||metadata.artifactId!==expectedArtifactId){
    location.replace(new URL('./',location.href).href);
  }else{
    await import('./src/main.js?v='+expectedArtifactId);
  }
}catch(error){
  document.body.textContent='Parallax could not verify the deployed site. Refresh to retry.';
  console.error('Parallax artifact bootstrap failed:',error);
}
</script>`;
}

export function transformApplicationHtml(sourceBytes, modulePaths, artifactId, expectedTokenCount){
  let html = Buffer.from(sourceBytes).toString('utf8');
  html = replaceExactly(
    html,
    ARTIFACT_ID_TOKEN,
    artifactId,
    expectedTokenCount,
    'index.html artifact token',
  );
  html = replaceExactly(
    html,
    IMPORT_MAP_TOKEN,
    createImportMap(modulePaths, artifactId),
    1,
    'index.html import map token',
  );
  html = replaceExactly(
    html,
    `<script type="module" src="src/main.js?v=${artifactId}"></script>`,
    createApplicationBootstrap(artifactId),
    1,
    'index.html main module bootstrap',
  );
  return Buffer.from(html, 'utf8');
}

export function createStableBootstrapHtml(){
  return Buffer.from(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2064%2064'%3E%3Crect%20width='64'%20height='64'%20rx='12'%20fill='%231e3d2b'/%3E%3Cpath%20d='M16%2038c8-20%2024-20%2032%200'%20fill='none'%20stroke='%23d9a07e'%20stroke-width='6'%20stroke-linecap='round'/%3E%3Ccircle%20cx='32'%20cy='32'%20r='7'%20fill='%23e5d9c4'/%3E%3C/svg%3E">
<title>Parallax</title>
<style>html{background:#0b0d0e;color:#c8b784;font:14px system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center}p{letter-spacing:.08em}</style>
</head>
<body><p id="status" role="status">Loading Parallax...</p>
<script>
(async()=>{
  const status=document.getElementById('status');
  try{
    const nonce=Date.now().toString(36)+'-'+crypto.getRandomValues(new Uint32Array(2)).join('-');
    const metadataUrl=new URL('parallax-site.json?request='+encodeURIComponent(nonce),location.href);
    const response=await fetch(metadataUrl,{cache:'no-store',credentials:'same-origin'});
    if(!response.ok)throw new Error('site metadata returned '+response.status);
    const metadata=await response.json();
    if(metadata.schemaVersion!==1||!/^[a-f0-9]{64}$/.test(metadata.artifactId||'')){
      throw new Error('site metadata is invalid');
    }
    const appUrl=new URL('app.html?v='+metadata.artifactId,location.href);
    location.replace(appUrl.href);
  }catch(error){
    status.textContent='Parallax could not verify the deployed site. Refresh to retry.';
    console.error('Parallax deployment bootstrap failed:',error);
  }
})();
</script></body>
</html>
`, 'utf8');
}

export function createSiteMetadata(artifactId, sourceTree){
  return Buffer.from(`${JSON.stringify({
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    artifactId,
    sourceTree,
  }, null, 2)}\n`, 'utf8');
}

export function createManifest(artifactId, sourceTree, artifactEntries){
  const files = [...artifactEntries].sort(comparePath).map(entry => {
    const bytes = Buffer.from(entry.bytes);
    return {
      path: toArtifactPath(entry.path),
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    };
  });
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    artifactId,
    sourceTree,
    files,
  };
}

export function serializeJson(value){
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function filesUnder(root, directory = root){
  const entries = [];
  for(const dirent of readdirSync(directory, { withFileTypes: true })){
    const absolutePath = join(directory, dirent.name);
    const stat = lstatSync(absolutePath);
    if(stat.isSymbolicLink()){
      throw new Error(`site artifact must not contain symbolic links: ${relative(root, absolutePath)}`);
    }
    if(dirent.isDirectory()) entries.push(...filesUnder(root, absolutePath));
    else if(dirent.isFile()) entries.push(toArtifactPath(relative(root, absolutePath)));
    else throw new Error(`site artifact contains unsupported entry: ${relative(root, absolutePath)}`);
  }
  return entries.sort();
}

export function assertContainedPath(parent, candidate, label){
  const parentPath = resolve(parent);
  const candidatePath = resolve(candidate);
  const prefix = parentPath.endsWith(sep) ? parentPath : `${parentPath}${sep}`;
  if(candidatePath !== parentPath && !candidatePath.startsWith(prefix)){
    throw new Error(`${label} must stay inside ${parentPath}`);
  }
  return candidatePath;
}

export function verifyArtifactDirectory(siteRoot){
  const root = resolve(siteRoot);
  const manifestPath = join(root, MANIFEST_FILE);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if(manifest.schemaVersion !== ARTIFACT_SCHEMA_VERSION){
    throw new Error(`unsupported site manifest schema: ${manifest.schemaVersion}`);
  }
  if(!/^[a-f0-9]{64}$/.test(manifest.artifactId || '')){
    throw new Error('site manifest artifactId must be a lowercase SHA-256 value');
  }
  if(!/^[a-f0-9]{40,64}$/.test(manifest.sourceTree || '')){
    throw new Error('site manifest sourceTree must be a Git object ID');
  }
  if(!Array.isArray(manifest.files) || !manifest.files.length){
    throw new Error('site manifest must list artifact files');
  }

  const expectedPaths = manifest.files.map(file => file.path).sort();
  const duplicatePaths = expectedPaths.filter((path, index) => path === expectedPaths[index - 1]);
  if(duplicatePaths.length) throw new Error(`site manifest has duplicate paths: ${duplicatePaths.join(', ')}`);

  const actualPaths = filesUnder(root).filter(path => path !== MANIFEST_FILE);
  if(JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)){
    throw new Error(`site artifact file set differs from manifest\nexpected: ${expectedPaths.join(', ')}\nactual: ${actualPaths.join(', ')}`);
  }

  for(const file of manifest.files){
    const absolutePath = assertContainedPath(root, join(root, file.path), `manifest path ${file.path}`);
    const bytes = readFileSync(absolutePath);
    if(bytes.byteLength !== file.bytes){
      throw new Error(`${file.path} byte count differs: expected ${file.bytes}, got ${bytes.byteLength}`);
    }
    const actualHash = sha256(bytes);
    if(actualHash !== file.sha256){
      throw new Error(`${file.path} hash differs: expected ${file.sha256}, got ${actualHash}`);
    }
    if(['.css', '.html', '.js', '.json', '.svg'].includes(extname(file.path).toLowerCase())
      && bytes.includes(Buffer.from(ARTIFACT_ID_TOKEN))){
      throw new Error(`${file.path} contains an unresolved artifact token`);
    }
  }

  const metadata = JSON.parse(readFileSync(join(root, SITE_METADATA_FILE), 'utf8'));
  if(metadata.schemaVersion !== ARTIFACT_SCHEMA_VERSION
    || metadata.artifactId !== manifest.artifactId
    || metadata.sourceTree !== manifest.sourceTree){
    throw new Error('site metadata does not match the manifest artifact');
  }

  const appHtml = readFileSync(join(root, 'app.html'), 'utf8');
  if(appHtml.includes(ARTIFACT_ID_TOKEN)) throw new Error('app.html contains an unresolved artifact token');
  if(!appHtml.includes(`?v=${manifest.artifactId}`)) throw new Error('app.html is not bound to the manifest artifact');

  return manifest;
}

export function verifyArtifactBundle(artifactRoot){
  const root = resolve(artifactRoot);
  const siteRoot = join(root, 'site');
  const manifest = verifyArtifactDirectory(siteRoot);
  const attestationPath = join(root, 'attestation.json');
  const attestationBytes = readFileSync(attestationPath);
  const attestation = JSON.parse(attestationBytes.toString('utf8'));
  const manifestBytes = readFileSync(join(siteRoot, MANIFEST_FILE));

  if(attestation.schemaVersion !== ARTIFACT_SCHEMA_VERSION
    || attestation.artifactId !== manifest.artifactId
    || attestation.sourceTree !== manifest.sourceTree
    || attestation.manifestSha256 !== sha256(manifestBytes)
    || attestation.fileCount !== manifest.files.length){
    throw new Error('site artifact attestation does not match the verified manifest');
  }
  if(!/^[a-f0-9]{40,64}$/.test(attestation.sourceCommit || '')){
    throw new Error('site artifact attestation sourceCommit must be a Git object ID');
  }

  return { manifest, attestation, siteRoot };
}
