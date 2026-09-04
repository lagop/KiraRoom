'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Calendar, Settings, CreditCard, LogOut, User, ChevronDown } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import apiClient, { removeToken } from '@/lib/api';
import { ClientNotificationBell } from './components/client-notification-bell';

interface UserData {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  role: string;
  tenantId?: string;
}

export default function AccountLayout({ 
  children, 
  params 
}: { 
  children: React.ReactNode;
  params: { salonName: string };
}) {
  const pathname = usePathname();
  const { toast } = useToast();
  const [currentUser, setCurrentUser] = useState<UserData | null>(null);
  const [showProfileMenu, setShowProfileMenu] = useState(false);

  // Check if user is already logged in
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const userStr = localStorage.getItem('user');
      if (userStr) {
        setCurrentUser(JSON.parse(userStr));
      } else {
        // Redirect to login if not logged in
        window.location.href = `/${params.salonName}`;
      }
    }
  }, [params.salonName]);

  const handleLogout = async () => {
    try {
      await apiClient.logout();
    } catch (error) {
      // Ignore logout errors
    }
    removeToken();
    if (typeof window !== 'undefined') {
      localStorage.removeItem('user');
    }
    setCurrentUser(null);
    window.location.href = `/sites/${params.salonName}`;
  };

  if (!currentUser) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin w-12 h-12 border-4 border-purple-500 border-t-transparent rounded-full"></div>
        <span className="ml-4 text-gray-600">Cargando...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-pink-50">
      {/* Navbar */}
      <nav className="bg-white shadow-sm border-b border-gray-200 sticky top-0 z-40">
        <div className="container mx-auto px-4">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 bg-purple-100 rounded-full flex items-center justify-center">
                <span className="font-semibold text-purple-600">KS</span>
              </div>
              <span className="font-semibold text-gray-900">
                {params.salonName.charAt(0).toUpperCase() + params.salonName.slice(1)}
              </span>
            </div>
            
            <div className="flex items-center space-x-4">
              {/* Notification Bell */}
              <ClientNotificationBell clientId={currentUser.id} tenantId={currentUser.tenantId} />
              
              <div 
                className="relative"
                onMouseEnter={() => setShowProfileMenu(true)}
                onMouseLeave={() => setShowProfileMenu(false)}
              >
                <div className="flex items-center space-x-3 cursor-pointer py-2">
                  <div className="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-white font-semibold text-sm">
                    {currentUser.firstName.charAt(0)}{currentUser.lastName.charAt(0)}
                  </div>
                  <div className="text-left hidden md:block">
                    <p className="text-sm font-medium text-gray-900">
                      {currentUser.firstName} {currentUser.lastName}
                    </p>
                    <p className="text-xs text-gray-500">{currentUser.email}</p>
                  </div>
                  <ChevronDown className="w-4 h-4 text-gray-500 hidden md:block" />
                </div>

                {/* Dropdown Menu */}
                {showProfileMenu && (
                  <div className="absolute right-0 top-full w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
                    <Link
                      href={`/sites/${params.salonName}/account/settings`}
                      className="flex items-center space-x-2 px-4 py-2 text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      <User className="w-4 h-4" />
                      <span>Perfil</span>
                    </Link>
                    <button
                      onClick={handleLogout}
                      className="flex items-center space-x-2 px-4 py-2 text-gray-700 hover:bg-gray-50 transition-colors w-full text-left"
                    >
                      <LogOut className="w-4 h-4" />
                      <span>Cerrar Sesión</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </nav>

      <div className="container mx-auto px-4 py-12">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Sidebar */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-2xl shadow-lg p-6 lg:sticky lg:top-24">
              <div className="flex flex-col items-center mb-6">
                <div className="w-20 h-20 rounded-full bg-purple-600 flex items-center justify-center text-white font-semibold text-2xl mb-3">
                  {params.salonName.charAt(0).toUpperCase()}
                </div>
                <h3 className="text-lg font-semibold text-gray-900">
                  {params.salonName.charAt(0).toUpperCase() + params.salonName.slice(1)}
                </h3>
              </div>

              <nav className="space-y-2">
                <Link
                  href={`/sites/${params.salonName}/account`}
                  className={`flex items-center space-x-3 px-4 py-2 rounded-lg transition-colors ${
                    pathname === `/sites/${params.salonName}/account`
                      ? 'bg-purple-50 text-purple-700'
                      : 'text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  <Calendar className="w-5 h-5" />
                  <span>Mis Citas</span>
                </Link>
                <Link
                  href={`/sites/${params.salonName}/account/new-appointment`}
                  className={`flex items-center space-x-3 px-4 py-2 rounded-lg transition-colors ${
                    pathname === `/sites/${params.salonName}/account/new-appointment`
                      ? 'bg-purple-50 text-purple-700'
                      : 'text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  <Calendar className="w-5 h-5" />
                  <span>Nueva Cita</span>
                </Link>
                <Link
                  href={`/sites/${params.salonName}/account/payment-methods`}
                  className={`flex items-center space-x-3 px-4 py-2 rounded-lg transition-colors ${
                    pathname === `/sites/${params.salonName}/account/payment-methods`
                      ? 'bg-purple-50 text-purple-700'
                      : 'text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  <CreditCard className="w-5 h-5" />
                  <span>Métodos de Pago</span>
                </Link>
                <Link
                  href={`/sites/${params.salonName}/account/settings`}
                  className={`flex items-center space-x-3 px-4 py-2 rounded-lg transition-colors ${
                    pathname === `/sites/${params.salonName}/account/settings`
                      ? 'bg-purple-50 text-purple-700'
                      : 'text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  <Settings className="w-5 h-5" />
                  <span>Configuración</span>
                </Link>
              </nav>
            </div>
          </div>

          {/* Main Content */}
          <div className="lg:col-span-2">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
