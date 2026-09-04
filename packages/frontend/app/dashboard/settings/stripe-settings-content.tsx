'use client';

import { useState, useEffect } from 'react';
import { CreditCard, Save, Eye, EyeOff, CheckCircle, AlertCircle, Key, ToggleLeft, ToggleRight, Banknote, Wallet } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import { apiClient, StripeSettings } from '@/lib/api';

interface PaymentMethod {
  id: string;
  name: string;
  icon: React.ReactNode;
  enabled: boolean;
  required?: boolean;  // For methods that cannot be disabled
  future?: boolean;     // For future development features
}

export function StripeSettingsContent() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [stripeSettings, setStripeSettings] = useState<StripeSettings | null>(null);
  const [showTestSecret, setShowTestSecret] = useState(false);
  const [showLiveSecret, setShowLiveSecret] = useState(false);
  
  // Payment methods state
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([
    {
      id: 'cash',
      name: 'Efectivo',
      icon: <Banknote className="w-5 h-5" />,
      enabled: true,
      required: true
    },
    {
      id: 'card',
      name: 'Tarjeta',
      icon: <CreditCard className="w-5 h-5" />,
      enabled: false
    },
    {
      id: 'paypal',
      name: 'PayPal',
      icon: <Wallet className="w-5 h-5" />,
      enabled: false,
      future: true
    }
  ]);
  
  // Form state
  const [formData, setFormData] = useState({
    stripeMode: 'test' as 'test' | 'live',
    stripeTestSecretKey: '',
    stripeTestPublishableKey: '',
    stripeLiveSecretKey: '',
    stripeLivePublishableKey: '',
  });

  useEffect(() => {
    loadStripeSettings();
  }, []);

  const loadStripeSettings = async () => {
    try {
      const settings = await apiClient.getStripeSettings();
      setStripeSettings(settings);
      setFormData({
        stripeMode: settings.stripeMode,
        stripeTestSecretKey: settings.stripeTestSecretKey || '',
        stripeTestPublishableKey: settings.stripeTestPublishableKey || '',
        stripeLiveSecretKey: settings.stripeLiveSecretKey || '',
        stripeLivePublishableKey: settings.stripeLivePublishableKey || '',
      });
    } catch (error) {
      console.error('Error loading Stripe settings:', error);
      toast({
        title: 'Error',
        description: 'No se pudieron cargar los ajustes de Stripe',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiClient.updateStripeSettings(formData);
      toast({
        title: 'Éxito',
        description: 'Configuración de Stripe guardada correctamente',
      });
      loadStripeSettings();
    } catch (error) {
      console.error('Error saving Stripe settings:', error);
      toast({
        title: 'Error',
        description: 'No se pudieron guardar los ajustes de Stripe',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const toggleMode = () => {
    const newMode = formData.stripeMode === 'test' ? 'live' : 'test';
    setFormData({ ...formData, stripeMode: newMode });
  };

  const togglePaymentMethod = (methodId: string) => {
    setPaymentMethods(prev => prev.map(pm => {
      if (pm.id === methodId) {
        // Don't allow toggling required or future methods
        if (pm.required || pm.future) return pm;
        return { ...pm, enabled: !pm.enabled };
      }
      return pm;
    }));
  };

  const isCardEnabled = paymentMethods.find(pm => pm.id === 'card')?.enabled ?? false;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Payment Methods */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Métodos de Pago</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {paymentMethods.map((method) => (
            <div 
              key={method.id}
              className={`flex items-center justify-between p-4 rounded-lg border-2 transition-all ${
                method.enabled 
                  ? 'border-purple-500 bg-purple-50' 
                  : method.future
                    ? 'border-gray-200 bg-gray-50 opacity-60'
                    : 'border-gray-200'
              }`}
            >
              <div className="flex items-center space-x-3">
                <div className={`p-2 rounded-lg ${
                  method.enabled 
                    ? 'bg-purple-100 text-purple-600' 
                    : 'bg-gray-100 text-gray-500'
                }`}>
                  {method.icon}
                </div>
                <div>
                  <p className="font-medium text-gray-900">{method.name}</p>
                  {method.required && (
                    <p className="text-xs text-gray-500">Siempre activo</p>
                  )}
                  {method.future && (
                    <p className="text-xs text-gray-500">No disponible todavía</p>
                  )}
                </div>
              </div>
              <button
                onClick={() => togglePaymentMethod(method.id)}
                disabled={method.required || method.future}
                className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg font-medium transition-colors ${
                  method.enabled 
                    ? 'bg-purple-600 text-white' 
                    : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                } ${(method.required || method.future) ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {method.enabled ? (
                  <>
                    <ToggleRight className="w-5 h-5" />
                    <span className="text-sm">Activo</span>
                  </>
                ) : (
                  <>
                    <ToggleLeft className="w-5 h-5" />
                    <span className="text-sm">Inactivo</span>
                  </>
                )}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Stripe Settings - Only enabled when card is active */}
      <div className={`space-y-6 ${!isCardEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
        {/* Mode Toggle */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Modo de Stripe</h2>
              <p className="text-sm text-gray-500">
                Actualmente usando: <span className="font-medium">{formData.stripeMode === 'test' ? 'Pruebas (Test)' : 'Producción (Live)'}</span>
              </p>
            </div>
            <button
              onClick={toggleMode}
              className={`flex items-center space-x-2 px-4 py-2 rounded-lg font-medium transition-colors ${
                formData.stripeMode === 'test' 
                  ? 'bg-yellow-100 text-yellow-800 hover:bg-yellow-200' 
                  : 'bg-green-100 text-green-800 hover:bg-green-200'
              }`}
            >
              {formData.stripeMode === 'test' ? (
                <>
                  <ToggleLeft className="w-5 h-5" />
                  <span>Modo Prueba</span>
                </>
              ) : (
                <>
                  <ToggleRight className="w-5 h-5" />
                  <span>Modo Producción</span>
                </>
              )}
            </button>
          </div>

          {/* Status indicator */}
          <div className="mt-4 flex items-center space-x-2">
            {stripeSettings?.isConfigured ? (
              <>
                <CheckCircle className="w-5 h-5 text-green-500" />
                <span className="text-sm text-green-600">Stripe configurado</span>
            </>
          ) : (
            <>
              <AlertCircle className="w-5 h-5 text-yellow-500" />
              <span className="text-sm text-yellow-600">Stripe no configurado - Usando claves globales</span>
            </>
          )}
        </div>
      </div>

      {/* Test Keys */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center space-x-2 mb-4">
          <Key className="w-5 h-5 text-yellow-600" />
          <h2 className="text-lg font-semibold text-gray-900">Claves de Prueba (Test)</h2>
        </div>
        
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Clave Secreta de Prueba (sk_test_...)
            </label>
            <div className="relative">
              <input
                type={showTestSecret ? 'text' : 'password'}
                value={formData.stripeTestSecretKey}
                onChange={(e) => setFormData({ ...formData, stripeTestSecretKey: e.target.value })}
                placeholder="sk_test_xxxxxxxxxxxxxxxxxxxxxxxx"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowTestSecret(!showTestSecret)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showTestSecret ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Clave Publicable de Prueba (pk_test_...)
            </label>
            <input
              type="text"
              value={formData.stripeTestPublishableKey}
              onChange={(e) => setFormData({ ...formData, stripeTestPublishableKey: e.target.value })}
              placeholder="pk_test_xxxxxxxxxxxxxxxxxxxxxxxx"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          </div>
        </div>
      </div>

      {/* Live Keys */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center space-x-2 mb-4">
          <Key className="w-5 h-5 text-green-600" />
          <h2 className="text-lg font-semibold text-gray-900">Claves de Producción (Live)</h2>
        </div>
        
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Clave Secreta de Producción (sk_live_...)
            </label>
            <div className="relative">
              <input
                type={showLiveSecret ? 'text' : 'password'}
                value={formData.stripeLiveSecretKey}
                onChange={(e) => setFormData({ ...formData, stripeLiveSecretKey: e.target.value })}
                placeholder="sk_live_xxxxxxxxxxxxxxxxxxxxxxxx"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowLiveSecret(!showLiveSecret)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                {showLiveSecret ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Clave Publicable de Producción (pk_live_...)
            </label>
            <input
              type="text"
              value={formData.stripeLivePublishableKey}
              onChange={(e) => setFormData({ ...formData, stripeLivePublishableKey: e.target.value })}
              placeholder="pk_live_xxxxxxxxxxxxxxxxxxxxxxxx"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          </div>
        </div>
      </div>

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center space-x-2 px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50"
        >
          {saving ? (
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
          ) : (
            <Save className="w-4 h-4" />
          )}
          <span>{saving ? 'Guardando...' : 'Guardar Configuración'}</span>
        </button>
      </div>
      </div>
    </div>
  );
}
