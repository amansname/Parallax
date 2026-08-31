import { readFile } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, sep } from 'node:path';
function contentType(filePath) {
  const ext = filePath.split('.').pop();
  return ext === 'html' ? 'text/html' : ext === 'js' ? 'text/javascript' : ext === 'css' ? 'text/css' : ext === 'png' ? 'image/png' : ext === 'svg' ? 'image/svg+xml' : 'application/octet-stream';
}
export function startStaticServer(VERIFIED_ARTIFACT, PORT) {
  const serverRoot = resolve(VERIFIED_ARTIFACT.siteRoot);
  const server = createServer((req, res) => {
    const rawPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const relPath = decodeURIComponent(rawPath).replace(/^\/+/, '');
    const filePath = resolve(serverRoot, relPath);
    if (filePath !== serverRoot && !filePath.startsWith(serverRoot + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    readFile(filePath, (err, body) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': contentType(filePath),
        'cache-control': 'no-store',
        'x-parallax-artifact-id': VERIFIED_ARTIFACT.manifest.artifactId,
        'x-parallax-source-commit': VERIFIED_ARTIFACT.attestation.sourceCommit
      });
      res.end(body);
    });
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(PORT, '127.0.0.1', () => ok(server));
  });
}
export function closeServer(server) {
  return new Promise(resolveClose => server.close(resolveClose));
}
