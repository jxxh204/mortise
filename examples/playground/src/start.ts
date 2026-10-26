import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toNodeListener } from '@mortise/server/node';
import handler from './server';
const origin = new URL(process.env.MORTISE_ORIGIN ?? 'http://127.0.0.1:8771');
const rpc = toNodeListener(handler, { publicOrigin: origin.origin });
const directory = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
    if (req.url?.split('?')[0]?.startsWith('/_mortise/')) {
        rpc(req, res);
        return;
    }
    void (async () => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405);
            res.end();
            return;
        }
        let pathname: string;
        try {
            pathname = decodeURIComponent(new URL(req.url ?? '/', origin).pathname);
        }
        catch {
            res.writeHead(400);
            res.end();
            return;
        }
        const file = path.resolve(directory, '.' + (pathname === '/' ? '/index.html' : pathname));
        if (!file.startsWith(directory + path.sep) || pathname.includes('\\') || pathname.includes('\0')) {
            res.writeHead(403);
            res.end();
            return;
        }
        try {
            if (!(await stat(file)).isFile())
                throw new Error();
            const bytes = await readFile(file);
            res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
            res.end(req.method === 'HEAD' ? undefined : bytes);
        }
        catch {
            res.writeHead(404);
            res.end('Not found');
        }
    })().catch(() => { if (!res.headersSent)
        res.writeHead(500); res.end(); });
});
server.listen(Number(origin.port || 80), origin.hostname, () => console.log(`Mortise production example: ${origin.origin}`));
