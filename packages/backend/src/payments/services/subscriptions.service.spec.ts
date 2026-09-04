import { SubscriptionsService, PLAN_MATRIX } from './subscriptions.service';

/**
 * P2A-receptionist-v2 -- locks the v2 plan matrix. If anyone edits
 * the matrix by accident this test fails immediately.
 *
 * Verified against the spec table in /home/user/.kilo/plans/
 * kira-studio-v2-plans.md (the canonical "v2 plans" document).
 */
describe('P2A-receptionist-v2: PLAN_MATRIX', () => {
  let subs: SubscriptionsService;

  beforeEach(() => {
    // The service has constructor deps (prisma, config) but the
    // matrix + plan details are static -- we never call them.
    subs = new SubscriptionsService({} as any, { get: () => undefined } as any);
  });

  it('esencial incluye whatsapp_notifications + virtual_receptionist (base IA, cap 500)', () => {
    expect(subs.plans.esencial.id).toBe('esencial');
    expect(subs.plans.esencial.maxProfessionals).toBe(4); // bumped 3 -> 4
    expect(subs.plans.esencial.maxClients).toBeNull();
    expect(subs.plans.esencial.maxAppointmentsPerMonth).toBeNull();
    expect(subs.plans.esencial.aiConversationsPerMonth).toBe(500);
    expect(subs.plans.esencial.minLocations).toBe(1);
    expect(PLAN_MATRIX.esencial).toEqual(
      expect.arrayContaining([
        'whatsapp_notifications',
        'virtual_receptionist',
      ]),
    );
    // H-4: Esencial stays web-only — `multichannel` is Pro+.
    expect(PLAN_MATRIX.esencial).not.toContain('multichannel');
  });

  it('pro incluye virtual_receptionist + virtual_receptionist_advanced + multichannel + las capacidades de crecer/operar', () => {
    expect(subs.plans.pro.id).toBe('pro');
    expect(subs.plans.pro.maxProfessionals).toBe(10);
    expect(subs.plans.pro.maxClients).toBeNull();
    expect(subs.plans.pro.aiConversationsPerMonth).toBeNull(); // ilimitado
    expect(PLAN_MATRIX.pro).toEqual(
      expect.arrayContaining([
        'whatsapp_notifications',
        'virtual_receptionist',
        'virtual_receptionist_advanced',
        'multichannel',
        'email_marketing',
        'loyalty',
        'promotions',
        'gift_cards',
        'wallet',
        'commissions',
        'advanced_analytics',
        'agenda_shifts',
      ]),
    );
  });

  it('empresa incluye todo de pro + multichannel + multi_location + consolidated_reports', () => {
    expect(subs.plans.empresa.id).toBe('empresa');
    expect(subs.plans.empresa.minLocations).toBe(1); // 2 -> 1 en v2
    expect(subs.plans.empresa.aiConversationsPerMonth).toBeNull();
    expect(PLAN_MATRIX.empresa).toEqual(
      expect.arrayContaining([
        'whatsapp_notifications',
        'virtual_receptionist',
        'virtual_receptionist_advanced',
        'multichannel',
        'multi_location',
        'consolidated_reports',
        // P2A-staff-copilot
        'copilot_read',
        'copilot_write',
      ]),
    );
  });

  it('P2A-staff-copilot: Pro tiene copilot_read, Empresa tiene ambos', () => {
    // Pro: read-only copilot (5 tools)
    expect(PLAN_MATRIX.pro).toContain('copilot_read');
    expect(PLAN_MATRIX.pro).not.toContain('copilot_write');
    // Empresa: full copilot
    expect(PLAN_MATRIX.empresa).toContain('copilot_write');
    // Esencial / Free: nada
    expect(PLAN_MATRIX.esencial).not.toContain('copilot_read');
    expect(PLAN_MATRIX.esencial).not.toContain('copilot_write');
  });

  it('resolveEffectiveAiCap aplica el add-on ai_expansion sobre cualquier plan', async () => {
    expect(subs.resolveEffectiveAiCap('esencial', false)).toBe(500);
    expect(subs.resolveEffectiveAiCap('esencial', true)).toBeNull();
    expect(subs.resolveEffectiveAiCap('pro', false)).toBeNull();
    expect(subs.resolveEffectiveAiCap('pro', true)).toBeNull();
    expect(subs.resolveEffectiveAiCap('empresa', false)).toBeNull();
  });

  it('upsellableAddOnsForPlan filtra los redundantes en Pro/Empresa', () => {
    const esencial = subs.upsellableAddOnsForPlan('esencial');
    expect(esencial).toContain('ai_expansion');
    expect(esencial).toContain('loyalty_giftcards');
    expect(esencial).toContain('email_marketing');
    // H-4: multichannel is included for Esencial (sold as add-on so the
    // salon can keep the €49 plan and only pay for the channels).
    expect(esencial).toContain('multichannel');

    const pro = subs.upsellableAddOnsForPlan('pro');
    expect(pro).not.toContain('ai_expansion'); // redundante en Pro
    expect(pro).toContain('loyalty_giftcards');
    expect(pro).toContain('email_marketing');
    // H-4: Pro already grants `multichannel` in PLAN_MATRIX, so the
    // filter removes the add-on from the catalog.
    expect(pro).not.toContain('multichannel');

    const empresa = subs.upsellableAddOnsForPlan('empresa');
    expect(empresa).not.toContain('ai_expansion');
    expect(empresa).not.toContain('multichannel');
  });
});
