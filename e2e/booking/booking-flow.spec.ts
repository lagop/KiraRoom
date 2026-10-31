/**
 * The core appointment flow, end to end, against real servers:
 *
 *   1. A salon signs up (POST /auth/register, fictitious data) and, through
 *      the API, gets a service, a professional with a weekly schedule,
 *      automatic invoicing and a closure on another day.
 *   2. A client books on the salon's public page: service, professional, a
 *      working day, an offered time, her details. A confirmation is shown.
 *   3. The closed day offers no times on that page.
 *   4. The owner signs in, finds the appointment in the calendar, in the
 *      professional's column, and completes it (confirm, start, complete,
 *      with the confirmation dialog).
 *   5. The appointment's invoice was issued, for the expected total.
 *
 * Every run makes a new salon, so it can run again on the same database.
 *
 * Runs against servers that are already up (`npm run test:e2e`):
 *   BASE_URL  the frontend, a production build (`next build` + `next start`)
 *             built with NEXT_PUBLIC_API_URL = API_URL.
 *             Default http://localhost:3000
 *   API_URL   the backend's API root. Default http://localhost:3001/api/v1
 *   E2E_BROWSER_CHANNEL  optional, e.g. "chrome" for the installed Chrome.
 * Start the backend with ops/ci/e2e-backend.sh: it never reads
 * packages/backend/.env and sets no provider key, so no email, SMS or
 * WhatsApp leaves the machine. Never run this against production: it signs
 * up salons and books appointments.
 */
import { APIRequestContext, expect, request, test } from "@playwright/test";

const API_URL = (process.env.API_URL ?? "http://localhost:3001/api/v1").replace(/\/+$/, "");
const SALON_TZ = "Europe/Madrid";

/** "YYYY-MM-DD" of today in the salon's zone. */
function salonToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SALON_TZ }).format(new Date());
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday. */
function weekday(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function daysBetween(from: string, to: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** A list endpoint's rows, whether it answers an array or { data }. */
function rows<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  const b = body as { data?: T[]; items?: T[] };
  return b.data ?? b.items ?? [];
}

const WORK_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

test("a client books online and the salon completes and invoices the visit", async ({ page }) => {
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const owner = {
    email: `e2e-owner-${runId}@example.com`,
    // Made up for this run; the salon exists only in the test database.
    password: `E2e-${runId}-pass`,
  };
  const salonName = `E2E Salon ${runId}`;
  const serviceName = `Corte E2E ${runId}`;
  const professional = { firstName: "Lucia", lastName: `Prueba ${runId}` };
  const professionalName = `${professional.firstName} ${professional.lastName}`;
  const client = { name: `Clara Cliente${runId}`, phone: "+34600111222" };
  const bookingTime = "10:00";

  // A Tuesday to Thursday at least two days ahead (inside the online
  // booking window, never "today"), and the closure the day after; the
  // professional works Monday to Saturday, so both are working days.
  const today = salonToday();
  let bookingDay = addDays(today, 2);
  while (![2, 3, 4].includes(weekday(bookingDay))) bookingDay = addDays(bookingDay, 1);
  const closureDay = addDays(bookingDay, 1);

  let api: APIRequestContext;
  let auth: Record<string, string> = {};
  let tenantId = "";
  let slug = "";
  let serviceId = "";
  let professionalId = "";

  await test.step("set up a salon through the API", async () => {
    api = await request.newContext();

    const signup = await api.post(`${API_URL}/auth/register`, {
      data: {
        email: owner.email,
        password: owner.password,
        salonName,
        phone: "+34600000000",
        ownerName: "Olga Propietaria",
        acceptTerms: true,
        language: "es",
        timezone: SALON_TZ,
      },
    });
    expect(signup.ok(), await signup.text()).toBeTruthy();
    const session = await signup.json();
    auth = { Authorization: `Bearer ${session.tokens.accessToken}` };

    // The onboarding wizard's required business details, so the panel opens
    // without its full-screen overlay.
    const tenantPatch = await api.patch(`${API_URL}/auth/tenant`, {
      headers: auth,
      data: { street: "Calle Falsa 123", city: "Madrid", postalCode: "28001", phone: "+34600000000" },
    });
    expect(tenantPatch.ok(), await tenantPatch.text()).toBeTruthy();
    const tenant = await (await api.get(`${API_URL}/auth/tenant`, { headers: auth })).json();
    tenantId = tenant.id;
    slug = tenant.slug;
    expect(slug).toBeTruthy();

    const service = await api.post(`${API_URL}/services`, {
      headers: auth,
      data: { name: serviceName, category: "hair", duration: 30, price: 30, isOnlineBookable: true },
    });
    expect(service.ok(), await service.text()).toBeTruthy();
    serviceId = (await service.json()).id;

    const pro = await api.post(`${API_URL}/professionals`, {
      headers: auth,
      data: {
        ...professional,
        email: `e2e-pro-${runId}@example.com`,
        workingHours: WORK_DAYS.map((day) => ({ day, openTime: "09:00", closeTime: "19:00" })),
      },
    });
    expect(pro.ok(), await pro.text()).toBeTruthy();
    professionalId = (await pro.json()).id;

    // Invoice every completed appointment, at 21 %, with the tax inside the
    // price the client was shown (salon-tax-settings.ts).
    const fiscal = await api.patch(`${API_URL}/invoices/settings/fiscal`, {
      headers: auth,
      data: { autoInvoiceAppointments: true, defaultTaxRate: 21, pricesIncludeTax: true },
    });
    expect(fiscal.ok(), await fiscal.text()).toBeTruthy();

    // The whole salon closed on another working day: no professional.
    const closure = await api.post(`${API_URL}/time-off`, {
      headers: auth,
      data: { kind: "closure", startDate: closureDay, endDate: closureDay, note: "Cierre E2E" },
    });
    expect(closure.ok(), await closure.text()).toBeTruthy();

    // Reading the state runs the onboarding detectors: business details,
    // a service and every professional's schedule are all there now.
    const onboarding = await (await api.get(`${API_URL}/onboarding/state`, { headers: auth })).json();
    expect(onboarding.finishedAt, "onboarding's required steps are done").toBeTruthy();
  });

  // No cookie banner over the page: the decision a visitor makes when she
  // refuses everything optional.
  await page.addInitScript(() => {
    localStorage.setItem(
      "kira-cookie-consent-v2",
      JSON.stringify({ necessary: true, preferences: false, analytics: false, marketing: false, decidedAt: new Date().toISOString() }),
    );
  });

  await test.step("book on the salon's public page", async () => {
    await page.goto(`/sites/${slug}`);
    await expect(page.getByRole("heading", { name: salonName }).first()).toBeVisible();

    await page.getByLabel(/Nombre/).fill(client.name);
    await page.getByLabel(/Tel[eé]fono/).fill(client.phone);
    await page.getByTestId("booking-service").selectOption(serviceId);
    await page.getByRole("button", { name: new RegExp(professionalName) }).click();
    await page.getByTestId("booking-date").fill(bookingDay);

    const slot = page.getByRole("button", { name: bookingTime, exact: true });
    await expect(slot).toBeEnabled();
    await slot.click();
    await page.getByRole("button", { name: "Confirmar reserva" }).click();

    await expect(page.getByText("Reserva confirmada").first()).toBeVisible();
  });

  await test.step("a closed day offers no times", async () => {
    await page.getByTestId("booking-service").selectOption(serviceId);
    await page.getByRole("button", { name: new RegExp(professionalName) }).click();
    await page.getByTestId("booking-date").fill(closureDay);

    await expect(page.getByText("El salón no abre este día")).toBeVisible();
    await expect(page.getByRole("button", { name: /^\d{2}:\d{2}$/ })).toHaveCount(0);

    // And the API agrees: nothing free that day.
    const res = await api.get(`${API_URL}/appointments/available-slots`, {
      params: { tenantId, professionalId, serviceId, date: closureDay },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const free = rows<{ isAvailable: boolean }>(await res.json()).filter((s) => s.isAvailable);
    expect(free).toHaveLength(0);
  });

  let appointmentId = "";
  await test.step("the booking reached the salon", async () => {
    const res = await api.get(`${API_URL}/appointments`, { headers: auth });
    expect(res.ok(), await res.text()).toBeTruthy();
    const mine = rows<{ id: string; professionalId: string; serviceId: string; scheduledTime: string }>(
      await res.json(),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ professionalId, serviceId, scheduledTime: bookingTime });
    appointmentId = mine[0].id;
  });

  await test.step("the owner finds it in the calendar, in the professional's column", async () => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(owner.email);
    await page.getByLabel("Contraseña").fill(owner.password);
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await page.waitForURL(/\/dashboard/);

    await page.goto("/dashboard/appointments");
    await page.getByRole("button", { name: "Calendario", exact: true }).click();

    const nextDay = page.getByRole("button", { name: "Día siguiente" });
    for (let i = daysBetween(today, bookingDay); i > 0; i--) await nextDay.click();
    const dayOfMonth = Number(bookingDay.slice(8, 10));
    await expect(page.getByRole("heading", { level: 2, name: new RegExp(`\\s${dayOfMonth}$`) })).toBeVisible();

    const column = page.getByTestId("professional-column").filter({ hasText: professionalName });
    await expect(column).toHaveCount(1);
    await expect(column.getByText(client.name)).toBeVisible();
    await expect(column.getByText(serviceName)).toBeVisible();
  });

  await test.step("the owner completes it from the panel", async () => {
    const column = page.getByTestId("professional-column").filter({ hasText: professionalName });
    await column.getByText(client.name).click();

    const drawer = page.getByRole("dialog").filter({ hasText: client.name }).last();
    await expect(drawer.getByText("Pendiente").first()).toBeVisible();

    await drawer.getByRole("button", { name: "Confirmar", exact: true }).click();
    await expect(drawer.getByText("Confirmada").first()).toBeVisible();
    await drawer.getByRole("button", { name: "Inicio", exact: true }).click();
    await expect(drawer.getByText("En curso").first()).toBeVisible();
    await drawer.getByRole("button", { name: "Completar", exact: true }).click();

    // Completing is final and issues the invoice, so the panel asks first.
    const ask = page.getByRole("dialog", { name: "¿Marcar la cita como completada?" });
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: "Marcar como completada" }).click();
    await expect(ask).toBeHidden();
    await expect(drawer.getByText("Completada").first()).toBeVisible();

    const res = await api.get(`${API_URL}/appointments/${appointmentId}`, { headers: auth });
    expect((await res.json()).status).toBe("completed");
  });

  await test.step("its invoice was issued for the expected total", async () => {
    // Issued in the background after the status change.
    let invoice: { sourceId: string; subtotalCents: number; totalCents: number; status: string } | undefined;
    await expect
      .poll(
        async () => {
          const res = await api.get(`${API_URL}/invoices`, { headers: auth });
          invoice = rows<NonNullable<typeof invoice>>(await res.json()).find((i) => i.sourceId === appointmentId);
          return !!invoice;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    // The 30,00 EUR the client was shown: 24,79 + 5,21 IVA.
    expect(invoice).toMatchObject({ subtotalCents: 2479, totalCents: 3000 });
  });

  await api!.dispose();
});
