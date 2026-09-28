'use client';

import { CreditCard } from 'lucide-react';

/**
 * Saved payment methods do not exist yet: there is no endpoint to store,
 * list or remove a client's card.
 *
 * This page used to show two invented cards (Visa •••• 1234, Mastercard
 * •••• 5678), and "add", "delete" and "set as default" changed only local
 * state before reporting success. A client could believe a card was on file
 * with the salon. It is kept as a route so old links land somewhere honest,
 * and is no longer linked from the account menu.
 */
export default function PaymentMethodsPage() {
  return (
    <div className="bg-white rounded-2xl shadow-sm p-8 text-center">
      <CreditCard className="w-12 h-12 mx-auto mb-4 text-gray-300" />
      <h1 className="text-xl font-semibold text-gray-900 mb-2">Métodos de pago</h1>
      <p className="text-gray-600 max-w-md mx-auto">
        Todavía no es posible guardar tarjetas en tu cuenta. El pago se
        realiza en el salón o, si el salón lo solicita, al reservar.
      </p>
    </div>
  );
}
