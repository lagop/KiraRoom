import { resolveIds } from './resolve-ids';

const RELAX = '11111111-1111-4111-8111-111111111111';
const DEEP = '22222222-2222-4222-8222-222222222222';
const ANA = '33333333-3333-4333-8333-333333333333';

function ctx() {
  return {
    tenantId: 't1',
    prisma: {
      service: {
        findMany: jest.fn().mockResolvedValue([
          { id: RELAX, name: 'Masaje Relajante' },
          { id: DEEP, name: 'Masaje Descontracturante' },
        ]),
      },
      professional: {
        findMany: jest.fn().mockResolvedValue([
          { id: ANA, firstName: 'Ana', lastName: 'Martínez' },
        ]),
      },
    },
  } as any;
}

/**
 * Found replaying a chat: the history the model sees keeps no tool results,
 * so by the third message the service UUID was gone and every first
 * check_availability / propose_appointment failed on serviceId.
 */
describe('resolveIds', () => {
  it('keeps a real id', async () => {
    const r = await resolveIds(ctx(), { serviceId: RELAX, date: '2026-10-02' });
    expect(r).toEqual({ ok: true, args: { serviceId: RELAX, date: '2026-10-02' } });
  });

  it.each(['Masaje Relajante', 'masaje relajante', 'MASAJE RELAJANTE ', 'relajante'])(
    'resolves the service name %p',
    async (name) => {
      const r = await resolveIds(ctx(), { serviceId: name });
      expect(r).toEqual({ ok: true, args: { serviceId: RELAX } });
    },
  );

  it('refuses an ambiguous name and lists the options', async () => {
    const r = await resolveIds(ctx(), { serviceId: 'masaje' });
    expect(r.ok).toBe(false);
    expect((r as any).error.error).toBe('service_not_found');
    expect((r as any).error.services).toHaveLength(2);
  });

  it('refuses an invented id', async () => {
    const r = await resolveIds(ctx(), { serviceId: '99999999-9999-4999-8999-999999999999' });
    expect(r.ok).toBe(false);
  });

  it('resolves a professional by name, accents or not', async () => {
    const r = await resolveIds(ctx(), { serviceId: RELAX, professionalId: 'Ana Martinez' });
    expect(r).toEqual({ ok: true, args: { serviceId: RELAX, professionalId: ANA } });
  });

  it('refuses a professional who does not do the service, and names who does', async () => {
    const CARMEN = '44444444-4444-4444-8444-444444444444';
    const c = ctx();
    c.prisma.professional.findMany.mockResolvedValue([
      { id: ANA, firstName: 'Ana', lastName: 'Martínez', services: [{ serviceId: RELAX }] },
      { id: CARMEN, firstName: 'Carmen', lastName: 'Sánchez', services: [] },
    ]);

    const r: any = await resolveIds(c, { serviceId: RELAX, professionalId: 'Carmen' });

    expect(r.ok).toBe(false);
    expect(r.error.error).toBe('professional_does_not_offer_service');
    expect(r.error.professionals).toEqual([{ id: ANA, name: 'Ana Martínez' }]);
  });

  it('leaves an absent professional absent', async () => {
    const c = ctx();
    const r = await resolveIds(c, { serviceId: RELAX });
    expect(r).toEqual({ ok: true, args: { serviceId: RELAX } });
    expect(c.prisma.professional.findMany).not.toHaveBeenCalled();
  });
});
