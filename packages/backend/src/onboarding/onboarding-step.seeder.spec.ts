import { OnboardingStepSeeder, RETIRED_STEP_KEYS } from './onboarding-step.seeder';

/**
 * D29: "Conecta los pagos" leaves the checklist while salons have no online
 * payment. Existing salons have its row from earlier boots: it is disabled,
 * so getState (enabled defs only) no longer lists or counts it.
 */
describe('OnboardingStepSeeder', () => {
  function seed() {
    const prisma: any = {
      onboardingStepDef: {
        upsert: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    return { prisma, run: () => new OnboardingStepSeeder(prisma).onModuleInit() };
  }

  it('no longer seeds the payment step', async () => {
    const { prisma, run } = seed();
    await run();
    const keys = prisma.onboardingStepDef.upsert.mock.calls.map((c: any[]) => c[0].where.key);
    expect(keys).not.toContain('payment_method');
    expect(keys).toContain('branding');
  });

  it('disables the row existing salons already have', async () => {
    const { prisma, run } = seed();
    await run();
    expect(RETIRED_STEP_KEYS).toContain('payment_method');
    expect(prisma.onboardingStepDef.updateMany).toHaveBeenCalledWith({
      where: { key: { in: ['payment_method'] }, enabled: true },
      data: { enabled: false },
    });
  });
});
