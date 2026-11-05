import { publicPrice, publicPriceSettings, PublicPriceSettings, taxIncludedNote } from '../../common/public-price';
import type { SalonToolContext } from './salon-tools';

/**
 * Prices as the receptionist quotes them: the final price, tax included
 * (common/public-price.ts), never the net catalogue figure of a salon that
 * writes its prices without the IVA. It used to say 30.00 EUR for what the
 * invoice then made 36.30.
 */
export async function clientPrices(ctx: Pick<SalonToolContext, 'prisma' | 'tenantId'>): Promise<PublicPriceSettings> {
  const tenant = await ctx.prisma.tenant.findUnique({
    where: { id: ctx.tenantId },
    select: { fiscalSettings: true },
  });
  return publicPriceSettings(tenant?.fiscalSettings);
}

/** "36.30": a catalogue price as the client pays it, as the tools give it. */
export function clientPriceText(price: unknown, prices: PublicPriceSettings): string {
  return publicPrice(price, prices).toFixed(2);
}

/** What the tools tell the model about the prices they return. */
export function priceNote(prices: PublicPriceSettings): string {
  return (
    `Prices are final: what the client pays, ${prices.taxLabel} included. ` +
    `Quote them exactly and say once that they include ${prices.taxLabel} ` +
    `("${taxIncludedNote(prices)}", or the same in the client's language).`
  );
}
