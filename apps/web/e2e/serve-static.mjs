// Serves the static export under a base path the way GitHub Pages serves a
// project site, so the Playwright suite can check the Pages build locally:
//   node e2e/serve-static.mjs <dir> <port> <basePath>
// - only paths under <basePath>/ exist; everything else is 404
// - a directory without a trailing slash redirects (301) to the slash form
// - a directory serves its index.html; "/x" also serves "x.html"
// - anything missing serves <dir>/404.html with status 404
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const [dirArg = "out", portArg = "3100", basePath = ""] = process.argv.slice(2);
const root = resolve(dirArg);
const port = Number(portArg);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

function send(res, status, file) {
  res.writeHead(status, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

function notFound(res) {
  const page = join(root, "404.html");
  if (isFile(page)) return send(res, 404, page);
  res.writeHead(404).end("Not found");
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  if (basePath && pathname === basePath) {
    res.writeHead(301, { location: `${basePath}/${url.search}` }).end();
    return;
  }
  if (!pathname.startsWith(`${basePath}/`)) return notFound(res);

  const relative = pathname.slice(basePath.length);
  const target = normalize(join(root, relative));
  if (target !== root && !target.startsWith(root + sep)) return notFound(res);

  if (existsSync(target) && statSync(target).isDirectory()) {
    if (!pathname.endsWith("/")) {
      res.writeHead(301, { location: `${pathname}/${url.search}` }).end();
      return;
    }
    const index = join(target, "index.html");
    return isFile(index) ? send(res, 200, index) : notFound(res);
  }
  if (isFile(target)) return send(res, 200, target);
  if (isFile(`${target}.html`)) return send(res, 200, `${target}.html`);
  return notFound(res);
}).listen(port, () => {
  console.log(`Serving ${root} at http://localhost:${port}${basePath}/`);
});
