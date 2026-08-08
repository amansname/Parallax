import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = process.cwd();
const host = "127.0.0.1";
const port = 8825;
const requestedHost = process.env.HOST || host;
const requestedPort = Number(process.env.PORT || port);

if (requestedHost !== host || requestedPort !== port) {
  console.error(`Parallax manual preview is fixed at http://${host}:${port}/ so saved browser data stays on one origin.`);
  process.exit(1);
}

const types = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
]);

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function fileForUrl(url) {
  const pathname = decodeURIComponent(new URL(url, `http://${host}:${port}`).pathname);
  const requested = pathname === "/" ? "/index.html" : pathname;
  const fullPath = normalize(resolve(join(root, requested)));
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (fullPath !== root && !fullPath.startsWith(rootPrefix)) return null;
  return fullPath;
}

const server = createServer((req, res) => {
  const filePath = fileForUrl(req.url || "/");
  if (!filePath) {
    send(res, 403, "Forbidden");
    return;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    send(res, 404, "Not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": types.get(extname(filePath).toLowerCase()) || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(res);
});

server.listen(port, host, () => {
  console.log(`Parallax preview running at http://${host}:${port}/`);
  console.log(`Serving ${root}`);
  console.log(`Wizard layout rev: 4 (household.css?v=19 — pinned footer, in-card step scroll)`);
});
