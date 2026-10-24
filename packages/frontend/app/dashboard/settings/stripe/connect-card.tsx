'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle, ExternalLink, ShieldCheck } from 'lucide-react';
import apiClient, { StripeConnectStatus } from '@/lib/api';
import { useToast } from '@/components/ui/use-toast';

/**
 * Deposits on online bookings: the salon connects its own Stripe account
 * (Stripe Connect). Stripe asks for the business and bank details on its own
 * pages; KiraRoom never sees them, and the deposits land in the salon's
 * account with no KiraRoom fee.
 */
export function StripeConnectCard() {
  const { toast } = useToast();
  const [status, setStatus] = useState<StripeConnectStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [redirecting, setRedirecting] = useState(false);
  const [returned, setReturned] = useState(false);

  useEffect(() => {
    // Stripe sends the salon back here with ?connect=return (done or left
    // halfway) or ?connect=refresh (the link expired: ask for a new one).
    const connect = new URLSearchParams(window.location.search).get('connect');
    setReturned(connect === 'return');
    apiClient
      .getStripeConnectStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
    if (connect === 'refresh') void connectAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connectAccount() {
    setRedirecting(true);
    try {
      const { url } = await apiClient.startStripeConnectOnboarding();
      window.location.href = url;
    } catch (err: any) {
      setRedirecting(false);
      toast({
        title: 'No se ha podido abrir Stripe',
        description: err?.message || 'Inténtalo de nuevo en unos minutos.',
        variant: 'destructive',
      });
    }
  }

  const ready = status?.chargesEnabled;
  const halfway = status?.connected && !status.chargesEnabled;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
      <div className="flex items-center space-x-2">
        <ShieldCheck className="w-5 h-5 text-purple-600" />
        <h2 className="text-lg font-semibold text-gray-900">Señal en las reservas online</h2>
      </div>
      <p className="text-sm text-gray-600">
        Pide una señal al reservar online los servicios que marques con depósito (en{' '}
        <a href="/dashboard/services" className="text-purple-600 underline">Servicios</a>). El cliente
        paga con tarjeta al reservar; el dinero va directo a tu cuenta de Stripe, sin comisión de
        KiraRoom. Si no paga en 30 minutos, el hueco se libera.
      </p>

      {loading ? (
        <div className="h-10 flex items-center text-sm text-gray-400">Comprobando tu cuenta…</div>
      ) : ready ? (
        <div className="flex items-center space-x-2 text-green-700">
          <CheckCircle className="w-5 h-5" />
          <span className="text-sm font-medium">Cuenta de Stripe conectada: ya puedes cobrar señales.</span>
        </div>
      ) : (
        <div className="space-y-3">
          {halfway && (
            <div className="flex items-start space-x-2 text-yellow-700">
              <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
              <span className="text-sm">
                {returned && !status?.detailsSubmitted
                  ? 'Te faltan datos por completar en Stripe.'
                  : 'Stripe todavía está revisando tu cuenta o le faltan datos. Hasta entonces las reservas se hacen sin señal.'}
              </span>
            </div>
          )}
          <button
            onClick={connectAccount}
            disabled={redirecting}
            className="inline-flex items-center space-x-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50"
          >
            <span>
              {redirecting
                ? 'Abriendo Stripe…'
                : halfway
                  ? 'Completar mis datos en Stripe'
                  : 'Conectar mi cuenta de Stripe'}
            </span>
            <ExternalLink className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
