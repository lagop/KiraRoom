import { loadProfessionalGaps, visitBusy } from './copilot-gaps';

/**
 * A visit with a service done by a colleague (Lucía's colour, then Marta's
 * rinse): the copilot's gaps used to count only the visit's own
 * professional, so Marta showed as free during the rinse.
 */

const DAY = '2026-11-03'; // a Tuesday
const TZ = 'Europe/Madrid';

function row(id: string, professionalId: string, minutes: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    professionalId,
    scheduledStart: null,
    scheduledEnd: null,
    isParallel: false,
    type: 'active',
    status: 'confirmed',
    service: { name: id, duration: minutes, bufferTime: 0 },
    ...extra,
  };
}

const SHARED_VISIT = {
  professionalId: 'lucia',
  scheduledDate: new Date(`${DAY}T00:00:00.000Z`),
  scheduledTime: '10:00',
  duration: 90,
  service: { bufferTime: 0 },
  services: [row('colour', 'lucia', 60), row('rinse', 'marta', 30)],
};

describe('visitBusy', () => {
  it('keeps each professional of a shared visit busy during her own services', () => {
    expect(visitBusy(SHARED_VISIT as any, TZ, DAY)).toEqual([
      { professionalId: 'lucia', start: '10:00', minutes: 60 },
      { professionalId: 'marta', start: '11:00', minutes: 30 },
    ]);
  });

  it('the cleanup goes to whoever ends the visit', () => {
    const visit = {
      ...SHARED_VISIT,
      services: [row('colour', 'lucia', 60), row('rinse', 'marta', 30, { service: { name: 'r', duration: 30, bufferTime: 10 } })],
    };
    expect(visitBusy(visit as any, TZ, DAY)).toContainEqual({ professionalId: 'marta', start: '11:30', minutes: 10 });
  });

  it('a visit done by its own professional reads as before', () => {
    const own = { ...SHARED_VISIT, services: [row('colour', 'lucia', 60), row('cut', 'lucia', 30)] };
    expect(visitBusy(own as any, TZ, DAY)).toEqual([{ professionalId: 'lucia', start: '10:00', minutes: 90 }]);
    const bare = { professionalId: 'lucia', scheduledTime: '10:00', duration: null, services: [] };
    expect(visitBusy(bare as any, TZ, DAY)).toEqual([{ professionalId: 'lucia', start: '10:00', minutes: 30 }]);
  });

  it('a cancelled service of the colleague does not keep her busy', () => {
    const visit = {
      ...SHARED_VISIT,
      services: [row('colour', 'lucia', 60), row('rinse', 'marta', 30, { status: 'cancelled' })],
    };
    expect(visitBusy(visit as any, TZ, DAY)).toEqual([{ professionalId: 'lucia', start: '10:00', minutes: 90 }]);
  });
});

describe('loadProfessionalGaps with a shared visit', () => {
  const shift = [{ day: 'tuesday', openTime: '10:00', closeTime: '12:00' }];
  function prisma() {
    return {
      professional: {
        findMany: jest.fn(async () => [
          { id: 'lucia', firstName: 'Lucía', workingHours: shift },
          { id: 'marta', firstName: 'Marta', workingHours: shift },
        ]),
      },
      appointment: { findMany: jest.fn(async () => [SHARED_VISIT]) },
      timeOff: { findMany: jest.fn(async () => []) },
    };
  }

  it("Marta is not free during the rinse she does in Lucía's visit", async () => {
    const p = prisma();
    const { gaps } = await loadProfessionalGaps(p, {
      tenantId: 't1',
      fromDay: DAY,
      toDay: DAY,
      todayDay: DAY,
      nowMinutes: 0,
      openingHours: null,
      timeZone: TZ,
      minGapMinutes: 30,
    });
    expect(gaps.map((g) => [g.professionalFirstName, g.start, g.end])).toEqual([
      ['Marta', '10:00', '11:00'],
      // Lucía is free while her colleague does the rinse, as the agenda reads it.
      ['Lucía', '11:00', '12:00'],
      ['Marta', '11:30', '12:00'],
    ]);
    // A colleague's visit where she does a service is read too.
    const where = (p.appointment.findMany.mock.calls[0] as any)[0].where;
    expect(where.OR).toEqual([
      { professionalId: { in: ['lucia', 'marta'] } },
      { services: { some: { professionalId: { in: ['lucia', 'marta'] } } } },
    ]);
  });
});
