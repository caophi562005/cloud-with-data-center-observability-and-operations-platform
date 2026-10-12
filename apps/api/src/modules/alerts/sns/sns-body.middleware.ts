import { raw, type RequestHandler } from 'express';

export const SNS_ALERTS_PATH = '/api/v1/alerts/sns';
/** Registered before Nest's default JSON parser; affects this machine POST only. */
export function snsBodyMiddleware(enabled: boolean): RequestHandler {
  const parser = raw({ type: ['application/json', 'text/plain'], limit: 512 * 1024, inflate: false });
  return (request, response, next) => {
    if (request.method !== 'POST' || ![SNS_ALERTS_PATH, `${SNS_ALERTS_PATH}/`].includes(request.path.toLowerCase())) { next(); return; }
    response.setHeader('Cache-Control', 'no-store');
    if (!enabled) { response.status(503).json({ code: 'ALERTS_UNAVAILABLE' }); return; }
    response.locals.snsDeadlineAt = Date.now() + 10_000;
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      if (!response.headersSent && !response.destroyed) {
        response.setHeader('Connection', 'close');
        response.status(503).json({ code: 'ALERTS_UNAVAILABLE' });
      } else response.destroy();
    }, 10_000);
    timer.unref();
    const cleanup = (): void => { clearTimeout(timer); };
    response.once('finish', () => { cleanup(); if (expired) request.destroy(); });
    response.once('close', cleanup);
    request.once('aborted', cleanup);
    const contentType = request.headers['content-type'] ?? '';
    if (!/^(?:application\/json|text\/plain)(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i.test(contentType)) {
      response.status(415).json({ code: 'ALERT_INPUT_INVALID' }); return;
    }
    parser(request, response, (error?: unknown) => {
      if (expired || response.headersSent || response.destroyed) return;
      if (error) {
        const status = typeof error === 'object' && 'status' in error && error.status === 413 ? 413 : 400;
        response.status(status).json({ code: 'ALERT_INPUT_INVALID' }); return;
      }
      try {
        if (!Buffer.isBuffer(request.body)) throw new Error('Invalid body');
        const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.body));
        request.body = body;
      } catch { response.status(400).json({ code: 'ALERT_INPUT_INVALID' }); return; }
      if (Date.now() >= Number(response.locals.snsDeadlineAt)) { response.status(503).json({ code: 'ALERTS_UNAVAILABLE' }); return; }
      next();
    });
  };
}
