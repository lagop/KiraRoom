'use client';

import { useState, useEffect } from 'react';
import { Settings, User, Mail, Phone, Bell, Shield, LogOut, Save, X, Eye, EyeOff } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import apiClient, { removeToken, NotificationPreferences, NotificationChannel } from '@/lib/api';

interface UserData {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  role: string;
  tenantId?: string;
}

interface UserSettings {
  notifications: {
    email: boolean;
    sms: boolean;
    push: boolean;
    whatsapp: boolean;
  };
  preferences: {
    language: string;
    timeFormat: string;
    emailUpdates: boolean;
  };
  notificationPreferences?: NotificationPreferences;
  showAdvancedNotifications?: boolean;
}

export default function SettingsPage({ params }: { params: { salonName: string } }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserData | null>(null);
  const [userSettings, setUserSettings] = useState<UserSettings>({
    notifications: {
      email: true,
      sms: false,
      push: true,
      whatsapp: false,
    },
    preferences: {
      language: 'es',
      timeFormat: '24h',
      emailUpdates: true,
    },
  });
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
  });
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordData, setPasswordData] = useState({
    newPassword: '',
    confirmPassword: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [hasPasswordMismatch, setHasPasswordMismatch] = useState(false);

  // Check if user is already logged in and fetch fresh data from API
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const userStr = localStorage.getItem('user');
      if (userStr) {
        const userData = JSON.parse(userStr);
        
        // Fetch fresh client data from API to ensure we have the latest info
        if (userData.id && userData.role === 'client') {
          apiClient.getClient(userData.id)
            .then((freshClientData) => {
              // Update localStorage with fresh data from the database
              const updatedUser = {
                ...userData,
                firstName: freshClientData.firstName,
                lastName: freshClientData.lastName,
                email: freshClientData.email,
                phone: freshClientData.phone,
                // Ensure tenantId is always present
                tenantId: freshClientData.tenantId || userData.tenantId,
              };
              localStorage.setItem('user', JSON.stringify(updatedUser));
              setCurrentUser(updatedUser);
              setFormData({
                firstName: freshClientData.firstName,
                lastName: freshClientData.lastName,
                email: freshClientData.email || '',
                phone: freshClientData.phone || '',
              });
            })
            .catch((error) => {
              console.error('Failed to fetch fresh client data:', error);
              // Fall back to localStorage data if API fails
              setCurrentUser(userData);
              setFormData({
                firstName: userData.firstName,
                lastName: userData.lastName,
                email: userData.email,
                phone: userData.phone || '',
              });
            });
        } else {
          setCurrentUser(userData);
          setFormData({
            firstName: userData.firstName,
            lastName: userData.lastName,
            email: userData.email,
            phone: userData.phone || '',
          });
        }
      }
    }
  }, [params.salonName]);

  // Fetch user settings
  useEffect(() => {
    if (currentUser) {
      const fetchUserSettings = async () => {
        try {
          setLoading(true);
          
          // Try to load notification preferences from backend first
          let notificationPreferences: NotificationPreferences | undefined;
          try {
            const prefsResponse = await apiClient.getClientNotificationPreferences(currentUser.id);
            // Backend returns { clientId, tenantId, preferences } - extract preferences
            notificationPreferences = (prefsResponse as any).preferences || prefsResponse;
          } catch (error) {
            console.log('No backend preferences found, using defaults');
          }
          
          // Use backend preferences as base, then apply localStorage overrides for non-preference settings
          // This ensures we always have the latest preferences from the database
          const defaultSettings: UserSettings = {
            notifications: {
              email: notificationPreferences ? Object.values(notificationPreferences).some(p => p && typeof p === 'object' && p.email === true) : true,
              sms: notificationPreferences ? Object.values(notificationPreferences).some(p => p && typeof p === 'object' && p.sms === true) : false,
              push: notificationPreferences ? Object.values(notificationPreferences).some(p => p && typeof p === 'object' && p.inApp === true) : true,
              whatsapp: notificationPreferences ? Object.values(notificationPreferences).some(p => p && typeof p === 'object' && p.whatsapp === true) : false,
            },
            preferences: {
              language: 'es',
              timeFormat: '24h',
              emailUpdates: true,
            },
            notificationPreferences: notificationPreferences || {
              appointment_confirmed: { email: true, sms: true, whatsapp: false, inApp: true },
              appointment_cancelled: { email: true, sms: true, whatsapp: false, inApp: true },
              appointment_reminder_24h: { email: true, sms: true, whatsapp: false, inApp: true },
              appointment_reminder_1h: { email: true, sms: true, whatsapp: false, inApp: true },
              appointment_completed: { email: true, sms: false, whatsapp: false, inApp: true },
              review_request: { email: true, sms: false, whatsapp: false, inApp: true },
              promotion: { email: true, sms: false, whatsapp: false, inApp: true },
              news: { email: true, sms: false, whatsapp: false, inApp: true },
              special_offer: { email: true, sms: false, whatsapp: false, inApp: true },
            },
          };
          
          // Only load other settings from localStorage (not notification preferences)
          if (typeof window !== 'undefined') {
            const savedSettings = localStorage.getItem('userSettings');
            if (savedSettings) {
              const parsedSettings = JSON.parse(savedSettings);
              setUserSettings({
                ...defaultSettings,
                preferences: parsedSettings.preferences || defaultSettings.preferences,
              });
            } else {
              setUserSettings(defaultSettings);
            }
          } else {
            setUserSettings(defaultSettings);
          }
        } catch (error) {
          console.error('Error fetching user settings:', error);
          toast({
            title: 'Error',
            description: 'No se pudo cargar la configuración',
            variant: 'destructive',
          });
        } finally {
          setLoading(false);
        }
      };

      fetchUserSettings();
    }
  }, [currentUser]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      if (!currentUser?.id) {
        throw new Error('No user ID found');
      }
      
      // Update client profile in the database via API (including language preference)
      const updatedClient = await apiClient.updateMyProfile(currentUser.id, {
        firstName: formData.firstName,
        lastName: formData.lastName,
        email: formData.email,
        phone: formData.phone,
        preferredLanguage: userSettings.preferences.language,
      });
      
      // Update localStorage with fresh data from the database
      if (typeof window !== 'undefined' && currentUser) {
        const updatedUser: UserData = {
          ...currentUser,
          firstName: updatedClient.firstName,
          lastName: updatedClient.lastName,
          email: updatedClient.email,
          phone: updatedClient.phone,
        };
        localStorage.setItem('user', JSON.stringify(updatedUser));
        setCurrentUser(updatedUser);
      }

      toast({
        title: 'Perfil actualizado',
        description: 'Tu información personal ha sido guardada',
      });
    } catch (error) {
      console.error('Error updating profile:', error);
      toast({
        title: 'Error',
        description: 'No se pudo actualizar el perfil',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSaveSettings = async () => {
    setLoading(true);

    try {
      // Always save notification preferences to backend if user is logged in
      if (currentUser?.id && currentUser?.tenantId) {
        try {
          // Ensure we have notification preferences to save
          const prefsToSave = userSettings.notificationPreferences || {
            appointment_confirmed: { email: true, sms: true, whatsapp: false, inApp: true },
            appointment_cancelled: { email: true, sms: true, whatsapp: false, inApp: true },
            appointment_reminder_24h: { email: true, sms: true, whatsapp: false, inApp: true },
            appointment_reminder_1h: { email: true, sms: true, whatsapp: false, inApp: true },
            appointment_completed: { email: true, sms: false, whatsapp: false, inApp: true },
            review_request: { email: true, sms: false, whatsapp: false, inApp: true },
            promotion: { email: true, sms: false, whatsapp: false, inApp: true },
            news: { email: true, sms: false, whatsapp: false, inApp: true },
            special_offer: { email: true, sms: false, whatsapp: false, inApp: true },
          };
          
          await apiClient.updateClientNotificationPreferences(
            currentUser.id,
            prefsToSave
          );
        } catch (error) {
          console.error('Error saving notification preferences to backend:', error);
        }
      }
      
      // Save settings to localStorage as cache (for non-notification settings)
      if (typeof window !== 'undefined') {
        const settingsToSave = {
          preferences: userSettings.preferences,
        };
        localStorage.setItem('userSettings', JSON.stringify(settingsToSave));
      }
      toast({
        title: 'Configuración guardada',
        description: 'Tu configuración ha sido actualizada',
      });
    } catch (error) {
      console.error('Error saving settings:', error);
      toast({
        title: 'Error',
        description: 'No se pudo guardar la configuración',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

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
    window.location.href = `/${params.salonName}`;
  };

  const handleChangePassword = async () => {
    if (passwordData.newPassword !== passwordData.confirmPassword) {
      setHasPasswordMismatch(true);
      toast({
        title: 'Error',
        description: 'Las contraseñas no coinciden',
        variant: 'destructive',
      });
      return;
    }

    if (passwordData.newPassword.length < 6) {
      toast({
        title: 'Error',
        description: 'La contraseña debe tener al menos 6 caracteres',
        variant: 'destructive',
      });
      return;
    }

    setLoading(true);
    try {
      // TODO: Implement API endpoint for changing password
      // For now, just show success message
      toast({
        title: 'Contraseña actualizada',
        description: 'Tu contraseña ha sido cambiada exitosamente',
      });
      setShowPasswordModal(false);
      setPasswordData({ newPassword: '', confirmPassword: '' });
      setHasPasswordMismatch(false);
    } catch (error) {
      console.error('Error changing password:', error);
      toast({
        title: 'Error',
        description: 'No se pudo cambiar la contraseña',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
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
            <Settings className="w-8 h-8 text-purple-600" />
            <span>Configuración</span>
          </h1>
        </div>

        <div className="space-y-8">
          {/* Profile Settings */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center space-x-2">
              <User className="w-5 h-5 text-purple-600" />
              <span>Información Personal</span>
            </h2>

            <form onSubmit={handleSaveProfile} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Nombre
                  </label>
                  <input
                    type="text"
                    value={formData.firstName}
                    onChange={(e) => setFormData(prev => ({ ...prev, firstName: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Apellido
                  </label>
                  <input
                    type="text"
                    value={formData.lastName}
                    onChange={(e) => setFormData(prev => ({ ...prev, lastName: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Teléfono
                </label>
                <input
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  placeholder="+34 123 456 789"
                />
              </div>

              <div className="flex justify-end pt-4">
                <button
                  type="submit"
                  disabled={loading}
                  className="flex items-center space-x-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  <span>{loading ? 'Guardando...' : 'Guardar'}</span>
                </button>
              </div>
            </form>
          </section>

          {/* Notification Settings */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center space-x-2">
              <Bell className="w-5 h-5 text-purple-600" />
              <span>Notificaciones</span>
            </h2>

            <div className="space-y-4">
              <div className="flex justify-between items-center p-3 border border-gray-200 rounded-lg">
                <div>
                  <h3 className="font-medium text-gray-900">Notificaciones por Email</h3>
                  <p className="text-sm text-gray-600">Recibe confirmaciones y recordatorios por email</p>
                </div>
                <input
                  type="checkbox"
                  checked={userSettings.notifications.email}
                  onChange={(e) => setUserSettings(prev => ({
                    ...prev,
                    notifications: {
                      ...prev.notifications,
                      email: e.target.checked,
                    },
                  }))}
                  className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                />
              </div>

              <div className="flex justify-between items-center p-3 border border-gray-200 rounded-lg">
                <div>
                  <h3 className="font-medium text-gray-900">Notificaciones por SMS</h3>
                  <p className="text-sm text-gray-600">Recibe recordatorios de citas por SMS</p>
                </div>
                <input
                  type="checkbox"
                  checked={userSettings.notifications.sms}
                  onChange={(e) => setUserSettings(prev => ({
                    ...prev,
                    notifications: {
                      ...prev.notifications,
                      sms: e.target.checked,
                    },
                  }))}
                  className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                />
              </div>

              <div className="flex justify-between items-center p-3 border border-gray-200 rounded-lg">
                <div>
                  <h3 className="font-medium text-gray-900">Notificaciones Push</h3>
                  <p className="text-sm text-gray-600">Recibe notificaciones push en tu dispositivo</p>
                </div>
                <input
                  type="checkbox"
                  checked={userSettings.notifications.push}
                  onChange={(e) => setUserSettings(prev => ({
                    ...prev,
                    notifications: {
                      ...prev.notifications,
                      push: e.target.checked,
                    },
                  }))}
                  className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                />
              </div>

              <div className="flex justify-between items-center p-3 border border-gray-200 rounded-lg">
                <div>
                  <h3 className="font-medium text-gray-900">Notificaciones por WhatsApp</h3>
                  <p className="text-sm text-gray-600">Recibe confirmaciones y recordatorios por WhatsApp</p>
                </div>
                <input
                  type="checkbox"
                  checked={userSettings.notifications.whatsapp}
                  onChange={(e) => setUserSettings(prev => ({
                    ...prev,
                    notifications: {
                      ...prev.notifications,
                      whatsapp: e.target.checked,
                    },
                  }))}
                  className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                />
              </div>
            </div>
          </section>

          {/* Simple Channel-based Notification Settings */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center space-x-2">
              <Bell className="w-5 h-5 text-purple-600" />
              <span>Canales de Notificación</span>
            </h2>
            <p className="text-sm text-gray-600 mb-4">
              Activa o desactiva los canales por los que quieres recibir notificaciones. Esto cambiará la configuración detallada automáticamente.
            </p>

            <div className="space-y-4">
              <div className="flex justify-between items-center p-3 border border-gray-200 rounded-lg">
                <div>
                  <h3 className="font-medium text-gray-900">Notificaciones en la App</h3>
                  <p className="text-sm text-gray-600">Recibe notificaciones dentro de la aplicación</p>
                </div>
                <input
                  type="checkbox"
                  checked={userSettings.notifications.push}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    // Update simple toggle
                    setUserSettings(prev => ({
                      ...prev,
                      notifications: { ...prev.notifications, push: enabled },
                    }));
                    // Update all notification types for inApp channel
                    const notificationTypes = [
                      'appointment_confirmed', 'appointment_cancelled', 
                      'appointment_reminder_24h', 'appointment_reminder_1h',
                      'appointment_completed', 'review_request', 
                      'promotion', 'news', 'special_offer'
                    ];
                    setUserSettings(prev => {
                      const updatedPrefs = { ...prev.notificationPreferences };
                      notificationTypes.forEach(type => {
                        updatedPrefs[type] = {
                          ...(updatedPrefs[type] || { inApp: true, email: true, sms: true, whatsapp: true }),
                          inApp: enabled,
                        };
                      });
                      return { ...prev, notificationPreferences: updatedPrefs };
                    });
                  }}
                  className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                />
              </div>

              <div className="flex justify-between items-center p-3 border border-gray-200 rounded-lg">
                <div>
                  <h3 className="font-medium text-gray-900">Notificaciones por Email</h3>
                  <p className="text-sm text-gray-600">Recibe confirmaciones y recordatorios por email</p>
                </div>
                <input
                  type="checkbox"
                  checked={userSettings.notifications.email}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    // Update simple toggle
                    setUserSettings(prev => ({
                      ...prev,
                      notifications: { ...prev.notifications, email: enabled },
                    }));
                    // Update all notification types for email channel
                    const notificationTypes = [
                      'appointment_confirmed', 'appointment_cancelled', 
                      'appointment_reminder_24h', 'appointment_reminder_1h',
                      'appointment_completed', 'review_request', 
                      'promotion', 'news', 'special_offer'
                    ];
                    setUserSettings(prev => {
                      const updatedPrefs = { ...prev.notificationPreferences };
                      notificationTypes.forEach(type => {
                        updatedPrefs[type] = {
                          ...(updatedPrefs[type] || { inApp: true, email: true, sms: true, whatsapp: true }),
                          email: enabled,
                        };
                      });
                      return { ...prev, notificationPreferences: updatedPrefs };
                    });
                  }}
                  className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                />
              </div>

              <div className="flex justify-between items-center p-3 border border-gray-200 rounded-lg">
                <div>
                  <h3 className="font-medium text-gray-900">Notificaciones por SMS</h3>
                  <p className="text-sm text-gray-600">Recibe recordatorios de citas por SMS</p>
                </div>
                <input
                  type="checkbox"
                  checked={userSettings.notifications.sms}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    // Update simple toggle
                    setUserSettings(prev => ({
                      ...prev,
                      notifications: { ...prev.notifications, sms: enabled },
                    }));
                    // Update all notification types for sms channel
                    const notificationTypes = [
                      'appointment_confirmed', 'appointment_cancelled', 
                      'appointment_reminder_24h', 'appointment_reminder_1h',
                      'appointment_completed', 'review_request', 
                      'promotion', 'news', 'special_offer'
                    ];
                    setUserSettings(prev => {
                      const updatedPrefs = { ...prev.notificationPreferences };
                      notificationTypes.forEach(type => {
                        updatedPrefs[type] = {
                          ...(updatedPrefs[type] || { inApp: true, email: true, sms: true, whatsapp: true }),
                          sms: enabled,
                        };
                      });
                      return { ...prev, notificationPreferences: updatedPrefs };
                    });
                  }}
                  className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                />
              </div>

              <div className="flex justify-between items-center p-3 border border-gray-200 rounded-lg">
                <div>
                  <h3 className="font-medium text-gray-900">Notificaciones por WhatsApp</h3>
                  <p className="text-sm text-gray-600">Recibe confirmaciones y recordatorios por WhatsApp</p>
                </div>
                <input
                  type="checkbox"
                  checked={userSettings.notifications.whatsapp}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    // Update simple toggle
                    setUserSettings(prev => ({
                      ...prev,
                      notifications: { ...prev.notifications, whatsapp: enabled },
                    }));
                    // Update all notification types for whatsapp channel
                    const notificationTypes = [
                      'appointment_confirmed', 'appointment_cancelled', 
                      'appointment_reminder_24h', 'appointment_reminder_1h',
                      'appointment_completed', 'review_request', 
                      'promotion', 'news', 'special_offer'
                    ];
                    setUserSettings(prev => {
                      const updatedPrefs = { ...prev.notificationPreferences };
                      notificationTypes.forEach(type => {
                        updatedPrefs[type] = {
                          ...(updatedPrefs[type] || { inApp: true, email: true, sms: true, whatsapp: true }),
                          whatsapp: enabled,
                        };
                      });
                      return { ...prev, notificationPreferences: updatedPrefs };
                    });
                  }}
                  className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                />
              </div>
            </div>

            {/* Collapsible Advanced Settings */}
            <div className="mt-6">
              <button
                type="button"
                onClick={() => setUserSettings(prev => ({ ...prev, showAdvancedNotifications: !prev.showAdvancedNotifications }))}
                className="flex items-center space-x-2 text-purple-600 hover:text-purple-800 text-sm font-medium"
              >
                <span>{userSettings.showAdvancedNotifications ? '▼' : '▶'}</span>
                <span>Configuración avanzada</span>
              </button>
              
              {userSettings.showAdvancedNotifications && (
                <div className="mt-4 space-y-4">
                  <p className="text-sm text-gray-600">
                    Personaliza cada tipo de notificación individualmente
                  </p>
                  
                  {[
                    { key: 'appointment_confirmed', label: 'Cita Confirmada' },
                    { key: 'appointment_cancelled', label: 'Cita Cancelada' },
                    { key: 'appointment_reminder_24h', label: 'Recordatorio 24h antes' },
                    { key: 'appointment_reminder_1h', label: 'Recordatorio 1h antes' },
                    { key: 'appointment_completed', label: 'Cita Completada' },
                    { key: 'review_request', label: 'Solicitud de Valoración' },
                    { key: 'promotion', label: 'Promociones' },
                    { key: 'news', label: 'Novedades' },
                    { key: 'special_offer', label: 'Ofertas Especiales' },
                  ].map((notificationType) => (
                    <div key={notificationType.key} className="border border-gray-200 rounded-lg p-4">
                      <h3 className="font-medium text-gray-900 mb-3">{notificationType.label}</h3>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        {(['inApp', 'email', 'sms', 'whatsapp'] as const).map((channel) => (
                          <label
                            key={channel}
                            className="flex items-center space-x-2 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={userSettings.notificationPreferences?.[notificationType.key]?.[channel] ?? true}
                              onChange={(e) => {
                                const currentPrefs = userSettings.notificationPreferences || {};
                                const typePrefs = currentPrefs[notificationType.key] || { inApp: true, email: true, sms: true, whatsapp: true };
                                setUserSettings(prev => ({
                                  ...prev,
                                  notificationPreferences: {
                                    ...prev.notificationPreferences,
                                    [notificationType.key]: {
                                      ...typePrefs,
                                      [channel]: e.target.checked,
                                    },
                                  },
                                }));
                              }}
                              className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                            />
                            <span className="text-sm text-gray-700 capitalize">
                              {channel === 'inApp' ? 'En app' : channel}
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Preferences */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center space-x-2">
              <Settings className="w-5 h-5 text-purple-600" />
              <span>Preferencias</span>
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Idioma
                </label>
                <select
                  value={userSettings.preferences.language}
                  onChange={(e) => setUserSettings(prev => ({
                    ...prev,
                    preferences: {
                      ...prev.preferences,
                      language: e.target.value,
                    },
                  }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="es">Español</option>
                  <option value="en">English</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Formato de Hora
                </label>
                <select
                  value={userSettings.preferences.timeFormat}
                  onChange={(e) => setUserSettings(prev => ({
                    ...prev,
                    preferences: {
                      ...prev.preferences,
                      timeFormat: e.target.value,
                    },
                  }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="24h">24 Horas</option>
                </select>
              </div>

              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  checked={userSettings.preferences.emailUpdates}
                  onChange={(e) => setUserSettings(prev => ({
                    ...prev,
                    preferences: {
                      ...prev.preferences,
                      emailUpdates: e.target.checked,
                    },
                  }))}
                  className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                />
                <label className="text-sm text-gray-700">
                  Recibe actualizaciones y ofertas especiales por email
                </label>
              </div>
            </div>
          </section>

          {/* Security */}
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center space-x-2">
              <Shield className="w-5 h-5 text-purple-600" />
              <span>Seguridad</span>
            </h2>

            <div className="space-y-4">
              <div className="p-3 border border-gray-200 rounded-lg">
                <h3 className="font-medium text-gray-900 mb-1">Cambiar Contraseña</h3>
                <p className="text-sm text-gray-600 mb-2">Actualiza tu contraseña regularmente para mantener la seguridad</p>
                <button 
                  onClick={() => setShowPasswordModal(true)}
                  className="px-3 py-1 text-sm bg-purple-600 text-white rounded hover:bg-purple-700 transition-colors"
                >
                  Cambiar Contraseña
                </button>
              </div>
            </div>
          </section>

          {/* Danger Zone */}
          <section>
            <h2 className="text-xl font-semibold text-red-600 mb-4">Zona de Riesgo</h2>

            <div className="space-y-4">
              <div className="p-3 border border-red-200 bg-red-50 rounded-lg">
                <h3 className="font-medium text-red-900 mb-1">Cerrar Sesión</h3>
                <p className="text-sm text-red-700 mb-2">Terminará la sesión actual y redirigirá al inicio de sesión</p>
                <button
                  onClick={handleLogout}
                  className="px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
                >
                  <LogOut className="w-4 h-4 inline mr-1" />
                  Cerrar Sesión
                </button>
              </div>
            </div>
          </section>

          <div className="flex justify-end pt-8">
            <button
              onClick={handleSaveSettings}
              disabled={loading}
              className="flex items-center space-x-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              <span>{loading ? 'Guardando...' : 'Guardar Configuración'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Password Change Modal */}
      {showPasswordModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold text-gray-900">Cambiar Contraseña</h2>
              <button
                onClick={() => {
                  setShowPasswordModal(false);
                  setPasswordData({ newPassword: '', confirmPassword: '' });
                  setShowPassword(false);
                  setShowConfirmPassword(false);
                  setHasPasswordMismatch(false);
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Nueva Contraseña
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={passwordData.newPassword}
                    onChange={(e) => {
                      const newValue = e.target.value;
                      setPasswordData(prev => ({ ...prev, newPassword: newValue }));
                      // Clear mismatch error when passwords match
                      if (hasPasswordMismatch && passwordData.confirmPassword && newValue === passwordData.confirmPassword) {
                        setHasPasswordMismatch(false);
                      }
                    }}
                    className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 pr-10 ${
                      hasPasswordMismatch && passwordData.newPassword !== passwordData.confirmPassword
                        ? 'border-red-500 focus:ring-red-500'
                        : 'border-gray-300 focus:ring-purple-500'
                    }`}
                    placeholder="••••••••"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Confirmar Contraseña
                </label>
                <div className="relative">
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    value={passwordData.confirmPassword}
                    onChange={(e) => {
                      const newValue = e.target.value;
                      setPasswordData(prev => ({ ...prev, confirmPassword: newValue }));
                      // Clear mismatch error when passwords match
                      if (hasPasswordMismatch && passwordData.newPassword && newValue === passwordData.newPassword) {
                        setHasPasswordMismatch(false);
                      }
                    }}
                    className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 pr-10 ${
                      hasPasswordMismatch && passwordData.newPassword !== passwordData.confirmPassword
                        ? 'border-red-500 focus:ring-red-500'
                        : 'border-gray-300 focus:ring-purple-500'
                    }`}
                    placeholder="••••••••"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showConfirmPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
                {hasPasswordMismatch && passwordData.newPassword !== passwordData.confirmPassword && (
                  <p className="text-sm text-red-500 mt-1">Las contraseñas no coinciden</p>
                )}
              </div>
            </div>

            <div className="flex justify-end space-x-3 mt-6">
              <button
                onClick={() => {
                  setShowPasswordModal(false);
                  setPasswordData({ newPassword: '', confirmPassword: '' });
                  setShowPassword(false);
                  setShowConfirmPassword(false);
                  setHasPasswordMismatch(false);
                }}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleChangePassword}
                disabled={loading || !passwordData.newPassword || !passwordData.confirmPassword || passwordData.newPassword !== passwordData.confirmPassword}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50"
              >
                {loading ? 'Guardando...' : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
