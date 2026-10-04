'use client';

import { useState, useEffect, useCallback } from 'react';
import { Settings, User, Bell, Shield, LogOut, Save, X, Eye, EyeOff, Mail } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import apiClient, { removeToken, MarketingConsentState } from '@/lib/api';
import {
  channelEnabled,
  emailChangeNeedsPassword,
  NOTIFICATION_TYPES,
  NotificationChannel,
  NotificationPrefs,
  profileChanges,
  ProfileFields,
  samePrefs,
  setChannel,
} from '@/lib/account-settings';

/**
 * The client's account settings on the salon site.
 *
 * Everything here is read from and written to the server, and "guardado"
 * is said only after the server answered. The page used to keep the
 * language, the time format and "ofertas por email" in localStorage, show a
 * block of channel toggles that were never sent, and read the profile from
 * an owner-only route (so it always showed what the browser kept since
 * sign-in).
 */

const CHANNELS: ReadonlyArray<{ key: NotificationChannel; title: string; desc: string; short: string }> = [
  { key: 'inApp', title: 'Notificaciones en la app', desc: 'Avisos dentro de tu cuenta en esta web', short: 'En la app' },
  { key: 'email', title: 'Notificaciones por email', desc: 'Confirmaciones y recordatorios por email', short: 'Email' },
  { key: 'sms', title: 'Notificaciones por SMS', desc: 'Recordatorios de citas por SMS', short: 'SMS' },
  { key: 'whatsapp', title: 'Notificaciones por WhatsApp', desc: 'Confirmaciones y recordatorios por WhatsApp', short: 'WhatsApp' },
];

type MarketingChoice = 'granted' | 'refused' | null;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return '';
  }
}

export default function SettingsPage({ params }: { params: { salonName: string } }) {
  const { toast } = useToast();
  const [signedIn, setSignedIn] = useState(false);
  const [loadingData, setLoadingData] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  // What the server has. The form is compared with it to know what changed.
  const [savedProfile, setSavedProfile] = useState<ProfileFields | null>(null);
  const [formData, setFormData] = useState<ProfileFields>({ firstName: '', lastName: '', email: '', phone: '' });
  const [emailPassword, setEmailPassword] = useState('');

  const [savedPrefs, setSavedPrefs] = useState<NotificationPrefs | null>(null);
  const [prefs, setPrefs] = useState<NotificationPrefs>({});
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [savedLanguage, setSavedLanguage] = useState<string | null>(null);
  const [language, setLanguage] = useState('es');

  const [marketing, setMarketing] = useState<MarketingConsentState | null>(null);
  const [marketingChoice, setMarketingChoice] = useState<MarketingChoice>(null);
  const [whatsappMarketing, setWhatsappMarketing] = useState<MarketingConsentState | null>(null);
  const [whatsappChoice, setWhatsappChoice] = useState<MarketingChoice>(null);

  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordData, setPasswordData] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [hasPasswordMismatch, setHasPasswordMismatch] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  const load = useCallback(async () => {
    setLoadingData(true);
    setLoadError(null);
    try {
      const [profile, prefsResponse, consent, whatsappConsent] = await Promise.all([
        apiClient.getMyProfile(),
        apiClient.getClientNotificationPreferences(''),
        apiClient.getMyMarketingConsent(),
        apiClient.getMyWhatsAppMarketingConsent(),
      ]);
      const fields: ProfileFields = {
        firstName: profile.firstName ?? '',
        lastName: profile.lastName ?? '',
        email: profile.email ?? '',
        phone: profile.phone ?? '',
      };
      setSavedProfile(fields);
      setFormData(fields);
      setSavedLanguage(profile.preferredLanguage || 'es');
      setLanguage(profile.preferredLanguage || 'es');
      // { clientId, tenantId, preferences } when stored; { preferences } (the defaults) otherwise.
      const serverPrefs = ((prefsResponse as any)?.preferences ?? {}) as NotificationPrefs;
      setSavedPrefs(serverPrefs);
      setPrefs(serverPrefs);
      setMarketing(consent);
      setMarketingChoice(consent.status === 'none' ? null : consent.status);
      setWhatsappMarketing(whatsappConsent);
      setWhatsappChoice(whatsappConsent.status === 'none' ? null : whatsappConsent.status);
      // The header reads the signed-in user from here: keep it current.
      try {
        const cached = JSON.parse(localStorage.getItem('user') || '{}');
        localStorage.setItem('user', JSON.stringify({ ...cached, ...fields, tenantId: profile.tenantId }));
      } catch {
        /* the cache is a convenience */
      }
    } catch (error) {
      console.error('Error loading account settings:', error);
      // No defaults in its place: saving them would overwrite real settings.
      setLoadError(errorMessage(error, 'No se pudo cargar tu configuración'));
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!localStorage.getItem('user')) return;
    // Settings this page used to keep in the browser only.
    localStorage.removeItem('userSettings');
    setSignedIn(true);
    load();
  }, [load, params.salonName]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!savedProfile) return;
    const changes = profileChanges(savedProfile, formData);
    if (Object.keys(changes).length === 0) {
      toast({ title: 'Sin cambios', description: 'No hay nada nuevo que guardar' });
      return;
    }
    const needsPassword = emailChangeNeedsPassword(savedProfile, formData);
    if (needsPassword && !emailPassword) {
      toast({
        title: 'Falta tu contraseña',
        description: 'Para cambiar el email con el que entras escribe tu contraseña actual',
        variant: 'destructive',
      });
      return;
    }
    setSavingProfile(true);
    try {
      const updated = await apiClient.updateMyProfile('', {
        ...changes,
        ...(needsPassword ? { currentPassword: emailPassword } : {}),
      });
      const fields: ProfileFields = {
        firstName: updated.firstName ?? '',
        lastName: updated.lastName ?? '',
        email: updated.email ?? '',
        phone: updated.phone ?? '',
      };
      setSavedProfile(fields);
      setFormData(fields);
      setEmailPassword('');
      try {
        const cached = JSON.parse(localStorage.getItem('user') || '{}');
        localStorage.setItem('user', JSON.stringify({ ...cached, ...fields }));
      } catch {
        /* the cache is a convenience */
      }
      toast({ title: 'Perfil guardado', description: 'Tus datos se han actualizado' });
    } catch (error) {
      console.error('Error updating profile:', error);
      toast({
        title: 'No se guardó el perfil',
        description: errorMessage(error, 'No se pudo actualizar el perfil'),
        variant: 'destructive',
      });
    } finally {
      setSavingProfile(false);
    }
  };

  const handleSaveSettings = async () => {
    if (!savedPrefs || savedLanguage === null) return;
    setSavingSettings(true);
    const done: string[] = [];
    try {
      if (!samePrefs(savedPrefs, prefs)) {
        const response = await apiClient.updateClientNotificationPreferences('', prefs);
        const stored = ((response as any)?.preferences ?? prefs) as NotificationPrefs;
        setSavedPrefs(stored);
        setPrefs(stored);
        done.push('notificaciones');
      }
      if (language !== savedLanguage) {
        const updated = await apiClient.updateMyProfile('', { preferredLanguage: language });
        setSavedLanguage(updated.preferredLanguage ?? language);
        done.push('idioma');
      }
      if (marketingChoice && marketingChoice !== marketing?.status) {
        const state = await apiClient.setMyMarketingConsent(marketingChoice === 'granted');
        setMarketing(state);
        setMarketingChoice(state.status === 'none' ? null : state.status);
        done.push('comunicaciones comerciales');
      }
      if (whatsappChoice && whatsappChoice !== whatsappMarketing?.status) {
        const state = await apiClient.setMyWhatsAppMarketingConsent(whatsappChoice === 'granted');
        setWhatsappMarketing(state);
        setWhatsappChoice(state.status === 'none' ? null : state.status);
        done.push('promociones por WhatsApp');
      }
      toast(
        done.length > 0
          ? { title: 'Configuración guardada', description: `Guardado: ${done.join(', ')}` }
          : { title: 'Sin cambios', description: 'No hay nada nuevo que guardar' },
      );
    } catch (error) {
      console.error('Error saving settings:', error);
      toast({
        title: 'No se guardó todo',
        description:
          (done.length > 0 ? `Guardado: ${done.join(', ')}. ` : '') +
          errorMessage(error, 'No se pudo guardar la configuración'),
        variant: 'destructive',
      });
    } finally {
      setSavingSettings(false);
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
    window.location.href = `/${params.salonName}`;
  };

  const closePasswordModal = () => {
    setShowPasswordModal(false);
    setPasswordData({ currentPassword: '', newPassword: '', confirmPassword: '' });
    setShowPassword(false);
    setShowConfirmPassword(false);
    setHasPasswordMismatch(false);
  };

  const handleChangePassword = async () => {
    if (passwordData.newPassword !== passwordData.confirmPassword) {
      setHasPasswordMismatch(true);
      toast({ title: 'Error', description: 'Las contraseñas no coinciden', variant: 'destructive' });
      return;
    }
    if (passwordData.newPassword.length < 8) {
      toast({ title: 'Error', description: 'La contraseña debe tener al menos 8 caracteres', variant: 'destructive' });
      return;
    }
    setChangingPassword(true);
    try {
      await apiClient.changeMyPassword(passwordData.currentPassword, passwordData.newPassword);
      toast({ title: 'Contraseña actualizada', description: 'Tu contraseña ha sido cambiada' });
      closePasswordModal();
    } catch (error) {
      console.error('Error changing password:', error);
      toast({
        title: 'Error',
        description: errorMessage(error, 'No se pudo cambiar la contraseña'),
        variant: 'destructive',
      });
    } finally {
      setChangingPassword(false);
    }
  };

  if (!signedIn) {
    return null;
  }

  const emailChanging = !!savedProfile && emailChangeNeedsPassword(savedProfile, formData);
  const settingsReady = !!savedPrefs && savedLanguage !== null && !!marketing && !!whatsappMarketing;
  const inputClass =
    'w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500';

  return (
    <>
      <div className="bg-white rounded-2xl shadow-lg p-8">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-3xl font-bold text-purple-900 flex items-center space-x-3">
            <Settings className="w-8 h-8 text-purple-600" />
            <span>Configuración</span>
          </h1>
        </div>

        {loadingData && <p className="text-sm text-gray-600">Cargando tu configuración…</p>}

        {loadError && !loadingData && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <p className="font-medium">No se pudo cargar tu configuración.</p>
            <p className="mt-1">{loadError}</p>
            <button
              type="button"
              onClick={load}
              className="mt-3 px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700"
            >
              Reintentar
            </button>
          </div>
        )}

        {!loadingData && !loadError && (
          <div className="space-y-8">
            {/* Profile */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center space-x-2">
                <User className="w-5 h-5 text-purple-600" />
                <span>Información personal</span>
              </h2>

              <form onSubmit={handleSaveProfile} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Nombre</label>
                    <input
                      type="text"
                      value={formData.firstName}
                      onChange={(e) => setFormData((prev) => ({ ...prev, firstName: e.target.value }))}
                      className={inputClass}
                      maxLength={100}
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Apellidos</label>
                    <input
                      type="text"
                      value={formData.lastName}
                      onChange={(e) => setFormData((prev) => ({ ...prev, lastName: e.target.value }))}
                      className={inputClass}
                      maxLength={100}
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData((prev) => ({ ...prev, email: e.target.value }))}
                    className={inputClass}
                    required
                  />
                  <p className="mt-1 text-xs text-gray-500">Es el email con el que entras en tu cuenta.</p>
                </div>

                {emailChanging && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Tu contraseña actual (para cambiar el email)
                    </label>
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={emailPassword}
                      onChange={(e) => setEmailPassword(e.target.value)}
                      className={inputClass}
                      required
                    />
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Teléfono</label>
                  <input
                    type="tel"
                    value={formData.phone}
                    onChange={(e) => setFormData((prev) => ({ ...prev, phone: e.target.value }))}
                    className={inputClass}
                    maxLength={30}
                    placeholder="+34 600 000 000"
                  />
                </div>

                <div className="flex justify-end pt-4">
                  <button
                    type="submit"
                    disabled={savingProfile}
                    className="flex items-center space-x-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50"
                  >
                    <Save className="w-4 h-4" />
                    <span>{savingProfile ? 'Guardando...' : 'Guardar perfil'}</span>
                  </button>
                </div>
              </form>
            </section>

            {/* Notification channels */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center space-x-2">
                <Bell className="w-5 h-5 text-purple-600" />
                <span>Notificaciones</span>
              </h2>
              <p className="text-sm text-gray-600 mb-4">
                Elige por dónde quieres recibir los avisos del salón sobre tus citas.
              </p>

              <div className="space-y-4">
                {CHANNELS.map((channel) => (
                  <label
                    key={channel.key}
                    className="flex justify-between items-center p-3 border border-gray-200 rounded-lg cursor-pointer"
                  >
                    <div>
                      <h3 className="font-medium text-gray-900">{channel.title}</h3>
                      <p className="text-sm text-gray-600">{channel.desc}</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={channelEnabled(prefs, channel.key)}
                      onChange={(e) => setPrefs((prev) => setChannel(prev, channel.key, e.target.checked))}
                      className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                    />
                  </label>
                ))}
              </div>

              <div className="mt-6">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="flex items-center space-x-2 text-purple-600 hover:text-purple-800 text-sm font-medium"
                >
                  <span>{showAdvanced ? '▼' : '▶'}</span>
                  <span>Configuración avanzada</span>
                </button>

                {showAdvanced && (
                  <div className="mt-4 space-y-4">
                    <p className="text-sm text-gray-600">Personaliza cada tipo de aviso</p>
                    {NOTIFICATION_TYPES.map((type) => (
                      <div key={type.key} className="border border-gray-200 rounded-lg p-4">
                        <h3 className="font-medium text-gray-900 mb-3">{type.label}</h3>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          {CHANNELS.map((channel) => (
                            <label key={channel.key} className="flex items-center space-x-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={prefs[type.key]?.[channel.key] === true}
                                onChange={(e) =>
                                  setPrefs((prev) => ({
                                    ...prev,
                                    [type.key]: { ...(prev[type.key] ?? {}), [channel.key]: e.target.checked },
                                  }))
                                }
                                className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                              />
                              <span className="text-sm text-gray-700">{channel.short}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            {/* Commercial communications: a recorded consent, not a checkbox kept in the browser */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center space-x-2">
                <Mail className="w-5 h-5 text-purple-600" />
                <span>Promociones y novedades</span>
              </h2>
              {marketing && (
                <div className="space-y-3">
                  <p className="text-sm text-gray-700">{marketing.text}</p>
                  <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
                    <label className="flex items-center space-x-2 cursor-pointer">
                      <input
                        type="radio"
                        name="marketing"
                        checked={marketingChoice === 'granted'}
                        onChange={() => setMarketingChoice('granted')}
                        className="border-gray-300 text-purple-600 focus:ring-purple-500"
                      />
                      <span className="text-sm text-gray-800">Sí, quiero recibirlas</span>
                    </label>
                    <label className="flex items-center space-x-2 cursor-pointer">
                      <input
                        type="radio"
                        name="marketing"
                        checked={marketingChoice === 'refused'}
                        onChange={() => setMarketingChoice('refused')}
                        className="border-gray-300 text-purple-600 focus:ring-purple-500"
                      />
                      <span className="text-sm text-gray-800">No, no quiero recibirlas</span>
                    </label>
                  </div>
                  <p className="text-xs text-gray-500">
                    {marketing.status === 'granted' &&
                      `Aceptaste el ${formatDate(marketing.decidedAt)}. Puedes retirarlo cuando quieras.`}
                    {marketing.status === 'refused' &&
                      `Indicaste el ${formatDate(marketing.decidedAt)} que no quieres recibirlas; el salón no te las enviará.`}
                    {marketing.status === 'none' &&
                      'Aún no lo has indicado. Como cliente, el salón puede enviarte ofertas por email hasta que digas que no.'}
                  </p>
                </div>
              )}
              {whatsappMarketing && (
                <div className="mt-6 space-y-3 border-t border-gray-100 pt-4">
                  <p className="text-sm text-gray-700">{whatsappMarketing.text}</p>
                  <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
                    <label className="flex items-center space-x-2 cursor-pointer">
                      <input
                        type="radio"
                        name="whatsapp-marketing"
                        checked={whatsappChoice === 'granted'}
                        onChange={() => setWhatsappChoice('granted')}
                        className="border-gray-300 text-purple-600 focus:ring-purple-500"
                      />
                      <span className="text-sm text-gray-800">Sí, por WhatsApp también</span>
                    </label>
                    <label className="flex items-center space-x-2 cursor-pointer">
                      <input
                        type="radio"
                        name="whatsapp-marketing"
                        checked={whatsappChoice === 'refused'}
                        onChange={() => setWhatsappChoice('refused')}
                        className="border-gray-300 text-purple-600 focus:ring-purple-500"
                      />
                      <span className="text-sm text-gray-800">No por WhatsApp</span>
                    </label>
                  </div>
                  <p className="text-xs text-gray-500">
                    {whatsappMarketing.status === 'granted' &&
                      `Aceptaste el ${formatDate(whatsappMarketing.decidedAt)}. Puedes darte de baja respondiendo BAJA a cualquier promoción.`}
                    {whatsappMarketing.status === 'refused' &&
                      `Indicaste el ${formatDate(whatsappMarketing.decidedAt)} que no quieres recibirlas por WhatsApp.`}
                    {whatsappMarketing.status === 'none' &&
                      'Aún no lo has indicado. Por WhatsApp solo te enviaremos promociones si lo aceptas.'}
                  </p>
                </div>
              )}
            </section>

            {/* Preferences */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center space-x-2">
                <Settings className="w-5 h-5 text-purple-600" />
                <span>Preferencias</span>
              </h2>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Idioma de los avisos</label>
                <select value={language} onChange={(e) => setLanguage(e.target.value)} className={inputClass}>
                  <option value="es">Español</option>
                  <option value="en">English</option>
                </select>
              </div>
            </section>

            <div className="flex justify-end">
              <button
                onClick={handleSaveSettings}
                disabled={savingSettings || !settingsReady}
                className="flex items-center space-x-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                <span>{savingSettings ? 'Guardando...' : 'Guardar configuración'}</span>
              </button>
            </div>

            {/* Security */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center space-x-2">
                <Shield className="w-5 h-5 text-purple-600" />
                <span>Seguridad</span>
              </h2>
              <div className="p-3 border border-gray-200 rounded-lg">
                <h3 className="font-medium text-gray-900 mb-1">Cambiar contraseña</h3>
                <p className="text-sm text-gray-600 mb-2">Actualiza tu contraseña regularmente para mantener la seguridad</p>
                <button
                  onClick={() => setShowPasswordModal(true)}
                  className="px-3 py-1 text-sm bg-purple-600 text-white rounded hover:bg-purple-700 transition-colors"
                >
                  Cambiar contraseña
                </button>
              </div>
            </section>

            {/* Session */}
            <section>
              <h2 className="text-xl font-semibold text-red-600 mb-4">Sesión</h2>
              <div className="p-3 border border-red-200 bg-red-50 rounded-lg">
                <h3 className="font-medium text-red-900 mb-1">Cerrar sesión</h3>
                <p className="text-sm text-red-700 mb-2">Terminará la sesión actual y volverás a la web del salón</p>
                <button
                  onClick={handleLogout}
                  className="px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
                >
                  <LogOut className="w-4 h-4 inline mr-1" />
                  Cerrar sesión
                </button>
              </div>
            </section>
          </div>
        )}
      </div>

      {showPasswordModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold text-gray-900">Cambiar contraseña</h2>
              <button onClick={closePasswordModal} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Contraseña actual</label>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={passwordData.currentPassword}
                  onChange={(e) => setPasswordData((prev) => ({ ...prev, currentPassword: e.target.value }))}
                  className={inputClass}
                  placeholder="••••••••"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nueva contraseña</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={passwordData.newPassword}
                    onChange={(e) => {
                      const newValue = e.target.value;
                      setPasswordData((prev) => ({ ...prev, newPassword: newValue }));
                      if (hasPasswordMismatch && newValue === passwordData.confirmPassword) setHasPasswordMismatch(false);
                    }}
                    className={`${inputClass} pr-10`}
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
                <label className="block text-sm font-medium text-gray-700 mb-1">Confirmar contraseña</label>
                <div className="relative">
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={passwordData.confirmPassword}
                    onChange={(e) => {
                      const newValue = e.target.value;
                      setPasswordData((prev) => ({ ...prev, confirmPassword: newValue }));
                      if (hasPasswordMismatch && newValue === passwordData.newPassword) setHasPasswordMismatch(false);
                    }}
                    className={`${inputClass} pr-10`}
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
                onClick={closePasswordModal}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleChangePassword}
                disabled={
                  changingPassword ||
                  !passwordData.currentPassword ||
                  !passwordData.newPassword ||
                  !passwordData.confirmPassword ||
                  passwordData.newPassword !== passwordData.confirmPassword
                }
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50"
              >
                {changingPassword ? 'Guardando...' : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
