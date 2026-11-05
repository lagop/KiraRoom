import { fiscalSettingsForTerritory, newSalonFiscalSettings, territoryTaxRegime } from "./salon-tax-settings";

/**
 * Audit 7 N6: a salon in the Canary Islands, Ceuta or Melilla started on
 * IVA 21 %, and its invoices said so until the owner changed it herself.
 */
describe("the tax regime of the salon's territory", () => {
  it("IGIC for a Canarian postcode or place, IPSI for Ceuta and Melilla", () => {
    expect(territoryTaxRegime({ postalCode: "35001" })).toBe("igic");
    expect(territoryTaxRegime({ postalCode: "38400", country: "ES" })).toBe("igic");
    expect(territoryTaxRegime({ city: "Las Palmas de Gran Canaria" })).toBe("igic");
    expect(territoryTaxRegime({ postalCode: "51001" })).toBe("ipsi");
    expect(territoryTaxRegime({ postalCode: "52005" })).toBe("ipsi");
    expect(territoryTaxRegime({ city: "Melilla" })).toBe("ipsi");
  });

  it("none for the peninsula, the Balearics or abroad", () => {
    expect(territoryTaxRegime({ postalCode: "28013", city: "Madrid" })).toBeNull();
    expect(territoryTaxRegime({ postalCode: "07001", city: "Palma" })).toBeNull();
    expect(territoryTaxRegime({ postalCode: "35000", country: "PT" })).toBeNull();
    expect(territoryTaxRegime({})).toBeNull();
  });

  it("Canary time counts when there is no address yet, but not over a peninsular postcode", () => {
    expect(territoryTaxRegime({}, "Atlantic/Canary")).toBe("igic");
    expect(territoryTaxRegime({ postalCode: "28013" }, "Atlantic/Canary")).toBeNull();
    expect(territoryTaxRegime({}, "Europe/Madrid")).toBeNull();
  });

  it("switches regime and rate, keeping the rest; nothing when already there", () => {
    const iva = { defaultSeries: "B", taxRegime: "iva", defaultTaxRate: 21, pricesIncludeTax: true };
    expect(fiscalSettingsForTerritory(iva, "igic")).toEqual({ ...iva, taxRegime: "igic", defaultTaxRate: 7 });
    expect(fiscalSettingsForTerritory(iva, "ipsi")).toEqual({ ...iva, taxRegime: "ipsi", defaultTaxRate: 10 });
    expect(fiscalSettingsForTerritory({ ...iva, taxRegime: "igic" }, "igic")).toBeNull();
    expect(fiscalSettingsForTerritory(iva, null)).toBeNull();
  });

  it("a new salon starts on its territory's tax", () => {
    expect(newSalonFiscalSettings({}, "Atlantic/Canary")).toMatchObject({ taxRegime: "igic", defaultTaxRate: 7, pricesIncludeTax: true });
    expect(newSalonFiscalSettings({ postalCode: "51001" })).toMatchObject({ taxRegime: "ipsi", defaultTaxRate: 10 });
    expect(newSalonFiscalSettings({}, "Europe/Madrid")).toMatchObject({ taxRegime: "iva", defaultTaxRate: 21 });
  });
});
