"use client";

import {
  BOOKING_PAYMENT_TEXT as T,
  PaymentChoice,
  ServiceOnlinePayment,
  effectiveChoice,
  euros,
  paymentOptions,
} from "@/lib/booking-payment";

/**
 * The payment step of a booking (page and widget): what the service asks her
 * to pay online and, where the salon allows, the choice between the señal,
 * the whole service, or paying at the salon. Nothing is drawn when the
 * service asks nothing online. The server decides who must pay and how much;
 * this only shows the offer and her pick.
 */
export function BookingPaymentChoice({
  offer,
  choice,
  onChange,
  disabled,
  accent = "text-purple-600 focus:ring-purple-500",
}: {
  offer: ServiceOnlinePayment | null | undefined;
  choice: PaymentChoice | null;
  onChange: (value: PaymentChoice) => void;
  disabled?: boolean;
  /** The tailwind classes of the radio, so the widget can follow the salon's colour. */
  accent?: string;
}) {
  const opts = paymentOptions(offer);
  if (!opts) return null;
  const picked = effectiveChoice(offer, choice);
  const label = (value: PaymentChoice, cents: number | null) =>
    value === "deposit" ? T.choiceDeposit(euros(cents ?? 0)) : value === "full" ? T.choiceFull(euros(cents ?? 0)) : T.choiceLater;
  const single = opts.options.length === 1;

  return (
    <fieldset data-test="booking-payment" className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-3 text-sm text-gray-700">
      <legend className="px-1 font-semibold text-gray-900">{T.title}</legend>
      <p>{opts.required ? T.depositNote(euros(opts.options[0].cents ?? 0)) : T.optionalNote}</p>
      {!single && (
        <div className="space-y-2" role="radiogroup" aria-label={T.title}>
          {opts.options.map((o) => (
            <label key={o.value} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="booking-payment"
                value={o.value}
                checked={picked === o.value}
                disabled={disabled}
                onChange={() => onChange(o.value)}
                className={`border-gray-300 ${accent}`}
              />
              <span>{label(o.value, o.cents)}</span>
            </label>
          ))}
        </div>
      )}
      {picked !== "later" && <p className="text-xs text-gray-500">{T.holdNote}</p>}
    </fieldset>
  );
}
