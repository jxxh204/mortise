import { createServer, type IncomingMessage, type ServerResponse, type RequestListener } from 'node:http';
import { DEFAULT_MAX_BODY_BYTES, errorResponse, MortiseHttpError, type MortiseHandler } from './index.js';

export interface NodeAdapterOptions {
  /** Trusted externally visible origin. Host and forwarded headers never select it. */
  publicOrigin: string;
  maxBodyBytes?: number;
}
function readNodeBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off('data', onData); request.off('end', onEnd);
      request.off('error', onError); request.off('aborted', onAborted);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onAborted = () => onError(new MortiseHttpError(400, 'REQUEST_ABORTED', 'The request was aborted.'));
    const tooLarge = () => {
      cleanup();
      request.resume();
      reject(new MortiseHttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds the size limit.'));
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { tooLarge(); return; }
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(new Uint8Array(Buffer.concat(chunks, size))); };
    const length = request.headers['content-length'];
    if (length && Number(length) > limit) { tooLarge(); return; }
    request.on('data', onData); request.on('end', onEnd);
    request.on('error', onError); request.on('aborted', onAborted);
  });
}
function waitForDrain(outgoing: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      outgoing.off('drain', onDrain); outgoing.off('close', onClose); outgoing.off('error', onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    outgoing.once('drain', onDrain); outgoing.once('close', onClose); outgoing.once('error', onError);
    if (outgoing.destroyed) onClose();
  });
}
async function writeResponse(response: Response, outgoing: ServerResponse) {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'set-cookie') outgoing.setHeader(key, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader('Set-Cookie', cookies);
  if (!response.body) { outgoing.end(); return; }
  const reader = response.body.getReader();
  try {
    while (!outgoing.destroyed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!outgoing.write(value)) await waitForDrain(outgoing);
    }
    outgoing.end();
  } finally {
    if (outgoing.destroyed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function toNodeListener(handler: MortiseHandler, options: NodeAdapterOptions): RequestListener {
  const parsed = new URL(options.publicOrigin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('publicOrigin must be an HTTP(S) origin without credentials');
  const origin = parsed.origin;
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('maxBodyBytes must be a positive integer');
  return (incoming, outgoing) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const onClose = () => { if (!outgoing.writableEnded) abort(); };
    incoming.once('aborted', abort);
    outgoing.once('close', onClose);
    void (async () => {
      try {
        const path = incoming.url ?? '/';
        if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new MortiseHttpError(400, 'INVALID_URL', 'A relative request path is required.');
        const url = new URL(`${origin}${path}`);
        if (url.origin !== origin) throw new MortiseHttpError(400, 'INVALID_URL', 'The request URL is invalid.');
        const method = incoming.method ?? 'GET';
        const headers = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
        const bytes = await readNodeBody(incoming, limit);
        const request = new Request(url, {
          method, headers, signal: controller.signal,
          ...(method === 'GET' || method === 'HEAD' ? {} : { body: bytes.buffer as ArrayBuffer }),
        });
        await writeResponse(await handler(request), outgoing);
      } catch (error) {
        if (!outgoing.headersSent && !outgoing.destroyed) await writeResponse(errorResponse(error), outgoing);
        else outgoing.destroy();
      } finally {
        incoming.off('aborted', abort);
        outgoing.off('close', onClose);
      }
    })();
  };
}
export function createMortiseServer(handler: MortiseHandler, options: NodeAdapterOptions) {
  return createServer(toNodeListener(handler, options));
}
