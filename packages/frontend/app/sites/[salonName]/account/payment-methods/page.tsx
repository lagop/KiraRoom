'use client';

import { useState, useEffect } from 'react';
import { CreditCard, Plus, Trash2, Edit2, Shield, CheckCircle2 } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import apiClient from '@/lib/api';

interface UserData {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  role: string;
}

interface PaymentMethod {
  id: string;
  cardNumber: string;
  cardBrand: string;
  expiryDate: string;
  isDefault: boolean;
}

export default function PaymentMethodsPage({ params }: { params: { salonName: string } }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserData | null>(null);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [editingMethod, setEditingMethod] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    cardNumber: '',
    cardBrand: '',
    expiryDate: '',
    isDefault: false,
  });

  // Check if user is already logged in
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const userStr = localStorage.getItem('user');
      if (userStr) {
        setCurrentUser(JSON.parse(userStr));
      }
    }
  }, [params.salonName]);

  // Fetch payment methods
  useEffect(() => {
    if (currentUser) {
      const fetchPaymentMethods = async () => {
        try {
          setLoading(true);
          // TODO: Implement API endpoint for payment methods
          const mockMethods: PaymentMethod[] = [
            {
              id: '1',
              cardNumber: '•••• •••• •••• 1234',
              cardBrand: 'Visa',
              expiryDate: '12/25',
              isDefault: true,
            },
            {
              id: '2',
              cardNumber: '•••• •••• •••• 5678',
              cardBrand: 'MasterCard',
              expiryDate: '08/26',
              isDefault: false,
            },
          ];
          setPaymentMethods(mockMethods);
        } catch (error) {
          console.error('Error fetching payment methods:', error);
          toast({
            title: 'Error',
            description: 'No se pudo cargar los métodos de pago',
            variant: 'destructive',
          });
        } finally {
          setLoading(false);
        }
      };

      fetchPaymentMethods();
    }
  }, [currentUser]);

  const handleAddPaymentMethod = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      // TODO: Implement API endpoint for adding payment methods
      const newMethod: PaymentMethod = {
        id: Date.now().toString(),
        ...formData,
        cardNumber: `•••• •••• •••• ${formData.cardNumber.slice(-4)}`,
      };

      setPaymentMethods(prev => [...prev, newMethod]);
      setIsAdding(false);
      setFormData({ cardNumber: '', cardBrand: '', expiryDate: '', isDefault: false });
      
      toast({
        title: 'Método de pago agregado',
        description: 'Tu nuevo método de pago ha sido guardado',
      });
    } catch (error) {
      console.error('Error adding payment method:', error);
      toast({
        title: 'Error',
        description: 'No se pudo agregar el método de pago',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDeletePaymentMethod = async (id: string) => {
    try {
      // TODO: Implement API endpoint for deleting payment methods
      setPaymentMethods(prev => prev.filter(method => method.id !== id));
      toast({
        title: 'Método de pago eliminado',
        description: 'El método de pago ha sido eliminado',
      });
    } catch (error) {
      console.error('Error deleting payment method:', error);
      toast({
        title: 'Error',
        description: 'No se pudo eliminar el método de pago',
        variant: 'destructive',
      });
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      // TODO: Implement API endpoint for setting default payment method
      setPaymentMethods(prev => 
        prev.map(method => ({
          ...method,
          isDefault: method.id === id,
        }))
      );
      toast({
        title: 'Método de pago predeterminado',
        description: 'El método de pago predeterminado ha sido actualizado',
      });
    } catch (error) {
      console.error('Error setting default payment method:', error);
      toast({
        title: 'Error',
        description: 'No se pudo actualizar el método de pago predeterminado',
        variant: 'destructive',
      });
    }
  };

  if (!currentUser) {
    return null;
  }

  return (
    <>
      <div className="bg-white rounded-2xl shadow-lg p-8">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold text-purple-900 flex items-center space-x-3">
            <CreditCard className="w-8 h-8 text-purple-600" />
            <span>Métodos de Pago</span>
          </h1>
          <button
            onClick={() => setIsAdding(true)}
            className="flex items-center space-x-2 bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>Agregar Método</span>
          </button>
        </div>

        <div className="mb-6">
          <div className="flex items-center space-x-2 text-sm text-gray-600">
            <Shield className="w-4 h-4 text-green-500" />
            <span>Todos los pagos son procesados de forma segura</span>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full"></div>
          </div>
        ) : paymentMethods.length > 0 ? (
          <div className="space-y-4">
            {paymentMethods.map(method => (
              <div
                key={method.id}
                className="border border-gray-200 rounded-lg p-4 flex justify-between items-center"
              >
                <div className="flex items-center space-x-4">
                  <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center">
                    <CreditCard className="w-6 h-6 text-purple-600" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900 flex items-center space-x-2">
                      <span>{method.cardBrand}</span>
                      {method.isDefault && (
                        <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded-full">
                          Predeterminado
                        </span>
                      )}
                    </h3>
                    <p className="text-sm text-gray-600">{method.cardNumber}</p>
                    <p className="text-xs text-gray-500">Expira {method.expiryDate}</p>
                  </div>
                </div>

                <div className="flex space-x-2">
                  {!method.isDefault && (
                    <button
                      onClick={() => handleSetDefault(method.id)}
                      className="p-2 text-purple-600 hover:text-purple-700 hover:bg-purple-50 rounded-lg transition-colors"
                      title="Establecer como predeterminado"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    onClick={() => setEditingMethod(method.id)}
                    className="p-2 text-gray-600 hover:text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
                    title="Editar"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDeletePaymentMethod(method.id)}
                    className="p-2 text-red-600 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors"
                    title="Eliminar"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-8">
            <CreditCard className="w-16 h-16 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              No hay métodos de pago
            </h3>
            <p className="text-gray-600 mb-4">
              Agrega tu primer método de pago para reservar citas con seguridad.
            </p>
            <button
              onClick={() => setIsAdding(true)}
              className="inline-flex items-center space-x-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>Agregar Método de Pago</span>
            </button>
          </div>
        )}
      </div>

      {/* Add Payment Method Modal */}
      {isAdding && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
            <div className="flex items-center justify-between p-6 border-b">
              <h2 className="text-2xl font-bold text-gray-900">Agregar Método de Pago</h2>
              <button
                onClick={() => setIsAdding(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <Trash2 className="h-6 w-6" />
              </button>
            </div>

            <div className="p-6">
              <form onSubmit={handleAddPaymentMethod} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Número de Tarjeta
                  </label>
                  <input
                    type="text"
                    value={formData.cardNumber}
                    onChange={(e) => setFormData(prev => ({ ...prev, cardNumber: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    placeholder="1234 5678 9010 1112"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Marca de Tarjeta
                  </label>
                  <select
                    value={formData.cardBrand}
                    onChange={(e) => setFormData(prev => ({ ...prev, cardBrand: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    required
                  >
                    <option value="">Selecciona una marca</option>
                    <option value="Visa">Visa</option>
                    <option value="MasterCard">MasterCard</option>
                    <option value="American Express">American Express</option>
                    <option value="Discover">Discover</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Fecha de Expiración
                  </label>
                  <input
                    type="text"
                    value={formData.expiryDate}
                    onChange={(e) => setFormData(prev => ({ ...prev, expiryDate: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    placeholder="MM/YY"
                    required
                  />
                </div>

                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="isDefault"
                    checked={formData.isDefault}
                    onChange={(e) => setFormData(prev => ({ ...prev, isDefault: e.target.checked }))}
                    className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                  />
                  <label htmlFor="isDefault" className="text-sm text-gray-700">
                    Establecer como método de pago predeterminado
                  </label>
                </div>

                <div className="flex space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setIsAdding(false)}
                    className="flex-1 px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition-colors"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50"
                  >
                    {loading ? 'Guardando...' : 'Guardar'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
