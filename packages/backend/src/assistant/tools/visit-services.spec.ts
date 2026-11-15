import { visitServices } from './salon-copilot-tools';

describe('visitServices (the services of a visit, as booked)', () => {
  it('reads a one-service booking that has no service lines', () => {
    // As the public booking page stores it: the service on the appointment.
    expect(
      visitServices({ serviceName: 'Corte de Cabello', service: { id: 's-1', name: 'Corte' }, services: [] }),
    ).toEqual([{ id: 's-1', name: 'Corte de Cabello' }]);
    expect(visitServices({ serviceName: null, service: { id: 's-1', name: 'Corte' }, services: [] })).toEqual([
      { id: 's-1', name: 'Corte' },
    ]);
  });

  it('prefers the service lines when there are some', () => {
    expect(
      visitServices({
        serviceName: 'Corte',
        service: { id: 's-1', name: 'Corte' },
        services: [
          { serviceName: 'Corte', service: { id: 's-1', name: 'Corte' } },
          { serviceName: null, service: { id: 's-2', name: 'Tinte' } },
        ],
      }),
    ).toEqual([
      { id: 's-1', name: 'Corte' },
      { id: 's-2', name: 'Tinte' },
    ]);
  });

  it('is empty when the visit has no service at all', () => {
    expect(visitServices({ serviceName: null, service: null, services: [] })).toEqual([]);
  });
});
