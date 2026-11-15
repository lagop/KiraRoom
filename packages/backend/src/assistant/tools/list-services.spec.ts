import { SalonCopilotToolsService } from './salon-copilot-tools';

/**
 * list_services: a service named in the chat becomes a serviceId. Without it
 * the copilot asked the owner for the service's "identificador interno"
 * before notifying the wait list.
 */
const SERVICES = [
  { id: 's-1', name: 'Corte de Cabello', duration: 30 },
  { id: 's-2', name: 'Mechas balayage', duration: 120 },
];

describe('list_services', () => {
  const prisma: any = { service: { findMany: jest.fn(async () => SERVICES) } };
  const ctx = { prisma, tenantId: 't-1', userId: 'u-1', role: 'owner' } as any;
  const svc = new SalonCopilotToolsService(prisma);

  it('lists the active services of the salon with their ids', async () => {
    const res: any = await svc.execute('list_services', {}, ctx);
    expect(res.services).toEqual([
      { serviceId: 's-1', name: 'Corte de Cabello', durationMinutes: 30 },
      { serviceId: 's-2', name: 'Mechas balayage', durationMinutes: 120 },
    ]);
    expect(prisma.service.findMany.mock.calls[0][0].where).toEqual({ tenantId: 't-1', isActive: true });
  });

  it('filters by name, accents and case ignored', async () => {
    const res: any = await svc.execute('list_services', { query: 'CÓRTE' }, ctx);
    expect(res.services.map((s: any) => s.serviceId)).toEqual(['s-1']);
    expect(res.total).toBe(1);
  });
});
