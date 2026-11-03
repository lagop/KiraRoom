import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AssistantController } from './assistant.controller';

/**
 * Client/server contract for /assistant/*.
 *
 * The panel's copilot posted to /assistant/conversations/:id/messages,
 * /assistant/conversations/:id/read and /assistant/messages/:id/feedback,
 * none of which existed: every message the salon typed came back 404. This
 * reads every /assistant call in the panel's API client and checks that the
 * controller has a route with that method and path.
 */

const API_TS = path.resolve(__dirname, '../../../frontend/lib/api.ts');

function normalise(p: string): string {
  return (
    '/' +
    p
      .split('/')
      .filter(Boolean)
      .map((seg) => (seg.startsWith(':') || seg.includes('${') ? ':param' : seg))
      .join('/')
  );
}

function clientCalls(): Array<{ method: string; path: string }> {
  const src = fs.readFileSync(API_TS, 'utf8');
  const re = /this\.request(?:<[^(]*?>)?\(\s*([`'"])(\/assistant[^`'"]*)\1\s*(?:,\s*\{\s*method:\s*['"](\w+)['"])?/g;
  const out: Array<{ method: string; path: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out.push({ method: (m[3] ?? 'GET').toUpperCase(), path: normalise(m[2].split('?')[0]) });
  }
  return out;
}

function serverRoutes(): Set<string> {
  const base = Reflect.getMetadata(PATH_METADATA, AssistantController) as string;
  const routes = new Set<string>();
  const proto = AssistantController.prototype as any;
  for (const name of Object.getOwnPropertyNames(proto)) {
    const handler = proto[name];
    if (typeof handler !== 'function' || name === 'constructor') continue;
    const sub = Reflect.getMetadata(PATH_METADATA, handler);
    const method = Reflect.getMetadata(METHOD_METADATA, handler);
    if (sub === undefined || method === undefined) continue;
    routes.add(`${RequestMethod[method]} ${normalise(`${base}/${sub}`)}`);
  }
  return routes;
}

describe('/assistant/* client/server contract', () => {
  it('finds the panel calls to check', () => {
    const calls = clientCalls();
    expect(calls.length).toBeGreaterThanOrEqual(8);
    expect(calls).toContainEqual({ method: 'POST', path: '/assistant/messages' });
  });

  it('every /assistant call in the panel has a matching route', () => {
    const routes = serverRoutes();
    const missing = clientCalls()
      .map((c) => `${c.method} ${c.path}`)
      .filter((key) => !routes.has(key));
    expect(missing).toEqual([]);
  });
});
