import { ParseUUIDPipe } from '@nestjs/common';

/**
 * SEC-2 (P2A-staff-copilot GA): smoke test for ParseUUIDPipe usage.
 *
 * We don't spin up the full Nest app here — that takes minutes and
 * already has coverage. Instead, we instantiate the pipe directly
 * and assert it rejects malformed UUIDs at the parameter boundary.
 * If a future refactor removes ParseUUIDPipe from a controller, an
 * integration test will fail; this spec catches the cheap half.
 */

function freshPipe() {
  return new ParseUUIDPipe({ version: '4' });
}

describe('SEC-2: ParseUUIDPipe (L-4)', () => {
  it('accepts a valid UUIDv4', async () => {
    const pipe = freshPipe();
    const value = 'a8b2c3d4-e5f6-4789-9abc-def012345678';
    const out = await pipe.transform(value, { type: 'param', data: 'id' } as any);
    expect(out).toBe(value);
  });

  it('rejects a non-UUID string', async () => {
    const pipe = freshPipe();
    await expect(
      pipe.transform('not-a-uuid', { type: 'param', data: 'id' } as any),
    ).rejects.toThrow();
  });

  it('rejects an empty string', async () => {
    const pipe = freshPipe();
    await expect(
      pipe.transform('', { type: 'param', data: 'id' } as any),
    ).rejects.toThrow();
  });

  it('rejects a numeric id (the kind Prisma would 500 on without the pipe)', async () => {
    const pipe = freshPipe();
    await expect(
      pipe.transform('12345', { type: 'param', data: 'id' } as any),
    ).rejects.toThrow();
  });

  it('rejects a UUID with the wrong version', async () => {
    // Construct a syntactically valid but wrong-version UUID (v1).
    const v1 = 'a8b2c3d4-1234-1234-8234-def012345678';
    const pipe = freshPipe();
    await expect(
      pipe.transform(v1, { type: 'param', data: 'id' } as any),
    ).rejects.toThrow();
  });
});
