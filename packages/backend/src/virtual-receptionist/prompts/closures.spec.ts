import { salonClosuresNotice } from './closures';

/**
 * The receptionist knew the weekly hours but not the closures the owner
 * recorded: asked for 24 December it found no slot and said nothing was free,
 * never that the salon is shut that day.
 */
describe('salonClosuresNotice', () => {
  // Saturday 31 October 2026, 10:00 in Madrid.
  const NOW = new Date('2026-10-31T09:00:00.000Z');
  const TZ = 'Europe/Madrid';

  it('lists the closures in plain dates, with the ISO days for the tools', () => {
    const notice = salonClosuresNotice(
      [
        { startDate: new Date('2026-12-24T00:00:00Z'), endDate: new Date('2026-12-26T00:00:00Z') },
        { startDate: '2026-12-08', endDate: '2026-12-08' },
      ],
      NOW,
      TZ,
      'es',
    );
    expect(notice).toContain('Cerrado el 8 de diciembre (2026-12-08)');
    expect(notice).toContain('Cerrado del 24 al 26 de diciembre (2026-12-24 a 2026-12-26)');
    // In date order, whatever order they came in.
    expect(notice.indexOf('8 de diciembre')).toBeLessThan(notice.indexOf('24 al 26'));
    expect(notice).toMatch(/^\[Cierres del salón en los próximos 60 días: /);
    expect(notice).toContain('No inventes el motivo');
  });

  it('names both months when a closure crosses one', () => {
    const notice = salonClosuresNotice([{ startDate: '2026-12-30', endDate: '2027-01-02' }], NOW, TZ, 'es');
    expect(notice).toContain('Cerrado del 30 de diciembre al 2 de enero (2026-12-30 a 2027-01-02)');
  });

  it('gives the hours of a closure for part of a day', () => {
    const notice = salonClosuresNotice(
      [{ startDate: '2026-12-23', endDate: '2026-12-23', startTime: '14:00', endTime: '20:00' }],
      NOW,
      TZ,
      'es',
    );
    expect(notice).toContain('Cerrado el 23 de diciembre de 14:00 a 20:00 (2026-12-23)');
  });

  it('describes a closure already under way from today', () => {
    const notice = salonClosuresNotice([{ startDate: '2026-10-29', endDate: '2026-11-02' }], NOW, TZ, 'es');
    expect(notice).toContain('Cerrado del 31 de octubre al 2 de noviembre (2026-10-31 a 2026-11-02)');
  });

  it('leaves out closures that are over or beyond the horizon', () => {
    const notice = salonClosuresNotice(
      [
        { startDate: '2026-10-20', endDate: '2026-10-30' }, // over yesterday
        { startDate: '2026-12-30', endDate: '2026-12-31' }, // day 60
        { startDate: '2027-01-15', endDate: '2027-01-15' }, // too far
      ],
      NOW,
      TZ,
      'es',
    );
    expect(notice).not.toContain('2026-10-30');
    expect(notice).toContain('2026-12-30');
    expect(notice).not.toContain('2027-01-15');
  });

  it("uses the salon's date near midnight", () => {
    // 23:30 UTC on the 1st is already the 2nd in Madrid: a closure that
    // ended on the 1st is over.
    const notice = salonClosuresNotice(
      [{ startDate: '2026-11-01', endDate: '2026-11-01' }],
      new Date('2026-11-01T23:30:00.000Z'),
      TZ,
      'es',
    );
    expect(notice).toBe('');
  });

  it('is empty when there is nothing to say, so the turn is unchanged', () => {
    expect(salonClosuresNotice([], NOW, TZ, 'es')).toBe('');
  });

  it('never carries a reason, even if a row with a note slips in', () => {
    const notice = salonClosuresNotice(
      [{ startDate: '2026-11-10', endDate: '2026-11-10', note: 'Baja de Ana', kind: 'sick_leave' } as any],
      NOW,
      TZ,
      'es',
    );
    expect(notice).toContain('Cerrado el 10 de noviembre (2026-11-10)');
    expect(notice).not.toContain('Ana');
    expect(notice).not.toContain('sick');
  });

  it('speaks English to an English salon', () => {
    const notice = salonClosuresNotice(
      [
        { startDate: '2026-12-24', endDate: '2026-12-26' },
        { startDate: '2026-12-30', endDate: '2027-01-02' },
        { startDate: '2026-12-08', endDate: '2026-12-08', startTime: '09:00', endTime: '12:00' },
      ],
      NOW,
      TZ,
      'en',
    );
    expect(notice).toContain('Closed on 8 December from 09:00 to 12:00 (2026-12-08)');
    expect(notice).toContain('Closed from 24 to 26 December (2026-12-24 to 2026-12-26)');
    expect(notice).toContain('Closed from 30 December to 2 January (2026-12-30 to 2027-01-02)');
    expect(notice).toMatch(/^\[Salon closures in the next 60 days: /);
  });
});
