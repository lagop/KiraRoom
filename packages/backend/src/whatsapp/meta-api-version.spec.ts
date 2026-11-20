import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_META_API_VERSION, metaApiVersion, metaGraphBaseUrl } from './meta-api-version';

describe('Meta Graph API version', () => {
  it('defaults to v25.0, available until July 2028 (v20.0 expired in September 2026)', () => {
    expect(DEFAULT_META_API_VERSION).toBe('v25.0');
    expect(metaApiVersion(undefined)).toBe('v25.0');
    expect(metaApiVersion('')).toBe('v25.0');
    expect(metaGraphBaseUrl(null)).toBe('https://graph.facebook.com/v25.0');
  });

  it('follows META_API_VERSION when it is a version', () => {
    expect(metaApiVersion('v26.0')).toBe('v26.0');
    expect(metaApiVersion(' v24.0 ')).toBe('v24.0');
    expect(metaGraphBaseUrl('v26.0')).toBe('https://graph.facebook.com/v26.0');
  });

  it('ignores a value that is not a version, instead of building a broken URL', () => {
    for (const bad of ['25', 'v25', 'latest', 'v25.0/../me', 'v25.0 ']) {
      expect(metaApiVersion(bad)).toBe(bad.trim() === 'v25.0' ? 'v25.0' : DEFAULT_META_API_VERSION);
    }
  });

  it('no code calls the Graph API with a version written by hand', () => {
    const src = path.join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name)) {
          if (/graph\.facebook\.com\/v\d/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(src, full));
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
