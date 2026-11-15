import { ParseCuidPipe } from './parse-cuid.pipe';

describe('ParseCuidPipe', () => {
  const pipe = new ParseCuidPipe();

  it('accepts a real conversation id (the kind ParseUUIDPipe rejected)', () => {
    expect(pipe.transform('cmwgj22um0001k79ebxmki8bz')).toBe('cmwgj22um0001k79ebxmki8bz');
  });

  it.each(['', 'not-an-id', '12345', 'a8b2c3d4-e5f6-4789-9abc-def012345678', "c'; drop table--xxxxxxxxxxxx", undefined])(
    'rejects %p',
    (value) => {
      expect(() => pipe.transform(value)).toThrow('Validation failed');
    },
  );
});
