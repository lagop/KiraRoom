'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "@/lib/use-translation";
import apiClient, { ChannelsConfig, ReceptionistStats } from "@/lib/api";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  ExternalLink,
  Info,
  Loader2,
  Lock,
  MessageCircle,
  MessageSquare,
  Send,
  ShieldAlert,
  X,
} from "lucide-react";

/**
 * P2A-receptionist-v2 H-4 frontend: the channels the virtual receptionist
 * answers on.
 *
 *   1. Web (always on)
 *   2. WhatsApp (connected in Ajustes > WhatsApp)
 *   3. Facebook Messenger + Instagram Direct: one Facebook Page, connected
 *      through Facebook Login. KiraRoom subscribes the Page to its webhook.
 *   4. Telegram: the salon's own bot; KiraRoom checks the token and
 *      registers the webhook.
 *
 * The first version asked for a Page access token, a webhook secret and
 * webhook URLs the salon was supposed to paste into Meta and BotFather, and
 * said nothing answered there. Now connecting is enough: messages arrive and
 * the receptionist replies.
 */

type ChannelName = "facebook" | "instagram" | "telegram";

/**
 * When the backend returns 403 (the `multichannel` feature is not in the
 * tenant's plan) an upgrade CTA replaces the channel list. The webhook
 * controllers drop messages for tenants without the feature too.
 *
 * The CTA branches on the tenant's plan:
 *   - esencial  → buy the Multicanal add-on (€19/mes)
 *   - anything else (defensive) → billing
 */
type LoadState =
  | { kind: "loading" }
  | { kind: "locked"; message: string; plan: string | null }
  | { kind: "ready"; plan: string | null }
  | { kind: "error"; message: string };

const EMPTY_CONFIG: ChannelsConfig = {
  enabled: true,
  enabledChannels: ["web"],
  meta: null,
  metaPagesPending: false,
  telegram: null,
};

/** `?meta=` values the Facebook Login callback redirects back with. */
const META_RESULT_KEYS: Record<string, string> = {
  connected: "billing.channels.metaResultConnected",
  no_pages: "billing.channels.metaResultNoPages",
  denied: "billing.channels.metaResultDenied",
  error: "billing.channels.metaResultError",
};

// useSearchParams() needs a Suspense boundary for the page to prerender.
export default function ChannelsSettingsPage() {
  return (
    <Suspense fallback={null}>
      <ChannelsSettingsContent />
    </Suspense>
  );
}

function ChannelsSettingsContent() {
  const t = useTranslations();
  const searchParams = useSearchParams();
  const metaResult = searchParams?.get("meta") ?? null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<ChannelsConfig>(EMPTY_CONFIG);
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [whatsappConnected, setWhatsappConnected] = useState(false);
  const [metaRedirecting, setMetaRedirecting] = useState(false);
  const [pickerDismissed, setPickerDismissed] = useState(false);

  const tRef = useRef(t);
  tRef.current = t;

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const [data, tenant, whatsapp] = await Promise.all([
        apiClient.getChannelsConfig(),
        apiClient.getTenant().catch(() => null),
        apiClient.getWhatsAppConnection().catch(() => null),
      ]);
      setWhatsappConnected(!!whatsapp);
      const plan = (tenant?.plan as string | undefined) ?? null;
      setConfig(data ?? EMPTY_CONFIG);
      setState({ kind: "ready", plan });
    } catch (err: any) {
      // ApiError carries `status`; FeatureGuard answers 403 when the
      // multichannel feature is not in the plan.
      if (err?.status === 403) {
        const tenant = await apiClient.getTenant().catch(() => null);
        const plan = (tenant?.plan as string | undefined) ?? null;
        setState({
          kind: "locked",
          message: tRef.current("billing.channels.upgradeRequiredMessage"),
          plan,
        });
        return;
      }
      setState({
        kind: "error",
        message: err?.message ?? tRef.current("billing.channels.errorLoading"),
      });
    }
  }, []);

  useEffect(() => {
    load();
    // load is intentionally only triggered on mount; subsequent renders must
    // not refetch config or the page enters a render loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isOn = (name: ChannelName) => config.enabledChannels.includes(name);

  const toggle = async (names: ChannelName[], next: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const set = new Set(config.enabledChannels);
      for (const name of names) {
        if (next) set.add(name);
        else set.delete(name);
      }
      const updated = await apiClient.updateChannelsConfig({
        enabledChannels: Array.from(set) as any,
      });
      setConfig(updated);
    } catch (err: any) {
      setError(err?.message ?? t("billing.channels.errorSaving"));
    } finally {
      setSaving(false);
    }
  };

  const connectFacebook = async () => {
    setError(null);
    setMetaRedirecting(true);
    try {
      const { url } = await apiClient.getMetaChannelConnectUrl();
      window.location.href = url;
    } catch (err: any) {
      setMetaRedirecting(false);
      setError(err?.message ?? t("billing.channels.metaResultError"));
    }
  };

  const disconnect = async (which: "meta" | "telegram") => {
    if (!window.confirm(t("billing.channels.disconnectConfirm"))) return;
    setSaving(true);
    setError(null);
    try {
      if (which === "meta") await apiClient.disconnectMetaChannel();
      else await apiClient.disconnectTelegramBot();
      await load();
    } catch (err: any) {
      setError(err?.message ?? t("billing.channels.errorSaving"));
    } finally {
      setSaving(false);
    }
  };

  const availability = config.availability;
  const metaAvailable = availability?.meta ?? false;
  const telegramAvailable = availability?.telegram ?? false;
  const meta = config.meta;
  const metaConnected = !!meta?.configured && !meta.needsReconnect;
  const telegram = config.telegram;
  const telegramConnected = !!telegram?.configured && !telegram.needsReconnect;
  const resultKey = metaResult ? META_RESULT_KEYS[metaResult] : undefined;

  return (
    <div className="space-y-6 p-6 max-w-4xl">
      <header>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <MessageCircle className="w-6 h-6" />
          {t("billing.channels.title")}
        </h1>
        <p className="text-gray-500 mt-1 text-sm">
          {t("billing.channels.subtitle")}
        </p>
        <p className="mt-3 rounded-md bg-violet-50 px-3 py-2 text-sm text-violet-900">
          {t("billing.channels.channelsNotice")}
        </p>
      </header>

      <ReceptionistActivityCard />

      {resultKey && (
        <div
          className={
            "rounded-md border p-3 text-sm inline-flex items-start gap-2 " +
            (metaResult === "connected"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-amber-200 bg-amber-50 text-amber-800")
          }
        >
          <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{t(resultKey)}</span>
        </div>
      )}

      {state.kind === "loading" ? (
        <div className="flex items-center justify-center h-40 text-gray-400">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : state.kind === "locked" ? (
        <LockedCard message={state.message} plan={state.plan} />
      ) : state.kind === "error" ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 inline-flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{state.message}</span>
          <button onClick={load} className="ml-auto underline text-xs">
            {t("billing.channels.retry")}
          </button>
        </div>
      ) : (
        <>
          {/* WEB */}
          <ChannelCard
            icon={<MessageCircle className="w-5 h-5" />}
            title={t("billing.channels.webTitle")}
            description={t("billing.channels.webDescription")}
            connected
            on
            alwaysOn
          />

          {/* WHATSAPP — configured in its own settings page */}
          <ChannelCard
            icon={<MessageSquare className="w-5 h-5" />}
            title={t("billing.channels.whatsappTitle")}
            description={t(
              whatsappConnected
                ? "billing.channels.whatsappConnectedDescription"
                : "billing.channels.whatsappDescription",
            )}
            connected={whatsappConnected}
            on={whatsappConnected}
            alwaysOn
            action={
              <a
                href="/dashboard/settings/whatsapp"
                className="px-3 py-1.5 text-xs rounded-md border border-emerald-300 text-emerald-700 hover:bg-emerald-50 inline-flex items-center gap-1"
              >
                {whatsappConnected ? t("billing.channels.manage") : t("billing.channels.connect")}
                <ChevronRight className="w-3 h-3" />
              </a>
            }
          />

          {/* META (Messenger + Instagram) */}
          <ChannelCard
            icon={<MessageSquare className="w-5 h-5" />}
            title={t("billing.channels.metaTitle")}
            description={t("billing.channels.metaDescription")}
            connected={metaConnected}
            on={metaConnected && (isOn("facebook") || isOn("instagram"))}
            onToggle={
              metaConnected
                ? (next) =>
                    toggle(meta?.instagramBusinessAccountId ? ["facebook", "instagram"] : ["facebook"], next)
                : undefined
            }
            disabled={saving}
            details={
              <>
                {metaConnected && meta?.pageName && (
                  <p className="text-xs text-gray-700">
                    {t("billing.channels.metaConnectedAs", { name: meta.pageName })}
                  </p>
                )}
                {metaConnected && meta?.instagramUsername && (
                  <p className="text-xs text-gray-700">
                    {t("billing.channels.metaInstagramAs", { username: meta.instagramUsername })}
                  </p>
                )}
                {metaConnected && !meta?.instagramBusinessAccountId && (
                  <p className="text-xs text-gray-500">{t("billing.channels.metaNoInstagram")}</p>
                )}
                {meta?.needsReconnect && (
                  <p className="text-xs text-amber-700">{t("billing.channels.reconnectNeeded")}</p>
                )}
                {!metaConnected && metaAvailable && (
                  <p className="text-xs text-gray-500">{t("billing.channels.metaHowTo")}</p>
                )}
                {!metaAvailable && (
                  <p className="text-xs text-amber-700">{t("billing.channels.metaUnavailable")}</p>
                )}
              </>
            }
            action={
              metaConnected ? (
                <button
                  onClick={() => disconnect("meta")}
                  disabled={saving}
                  className="px-3 py-1.5 text-xs rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {t("billing.channels.disconnect")}
                </button>
              ) : metaAvailable ? (
                <button
                  onClick={connectFacebook}
                  disabled={metaRedirecting}
                  className="px-3 py-1.5 text-xs rounded-md border border-violet-300 text-violet-700 hover:bg-violet-50 inline-flex items-center gap-1 disabled:opacity-50"
                >
                  {metaRedirecting ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <ExternalLink className="w-3 h-3" />
                  )}
                  {metaRedirecting ? t("billing.channels.connecting") : t("billing.channels.connectFacebook")}
                </button>
              ) : null
            }
          />

          {/* TELEGRAM */}
          <ChannelCard
            icon={<Send className="w-5 h-5" />}
            title={t("billing.channels.telegramTitle")}
            description={t("billing.channels.telegramDescription")}
            connected={telegramConnected}
            on={telegramConnected && isOn("telegram")}
            onToggle={telegramConnected ? (next) => toggle(["telegram"], next) : undefined}
            disabled={saving}
            details={
              <>
                {telegramConnected && telegram?.botUsername && (
                  <p className="text-xs text-gray-700">
                    {t("billing.channels.telegramConnectedAs", { username: telegram.botUsername })}
                  </p>
                )}
                {telegram?.needsReconnect && (
                  <p className="text-xs text-amber-700">{t("billing.channels.reconnectNeeded")}</p>
                )}
                {!telegramAvailable && (
                  <p className="text-xs text-amber-700">{t("billing.channels.telegramUnavailable")}</p>
                )}
              </>
            }
            action={
              telegramConnected ? (
                <button
                  onClick={() => disconnect("telegram")}
                  disabled={saving}
                  className="px-3 py-1.5 text-xs rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {t("billing.channels.disconnect")}
                </button>
              ) : telegramAvailable ? (
                <button
                  onClick={() => setTelegramOpen(true)}
                  className="px-3 py-1.5 text-xs rounded-md border border-emerald-300 text-emerald-700 hover:bg-emerald-50 inline-flex items-center gap-1"
                >
                  {t("billing.channels.connect")}
                  <ChevronRight className="w-3 h-3" />
                </button>
              ) : null
            }
          />

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 inline-flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <p className="text-xs text-gray-400 flex items-start gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5 mt-0.5" />
            {t("billing.channels.scopeNotice")}
          </p>
        </>
      )}

      {/* Several Pages after Facebook Login: the salon picks one. */}
      {state.kind === "ready" && config.metaPagesPending && !pickerDismissed && (
        <MetaPagePicker
          onClose={() => setPickerDismissed(true)}
          onDone={() => load()}
        />
      )}

      {telegramOpen && (
        <TelegramWizard
          onClose={() => setTelegramOpen(false)}
          onSaved={async () => {
            setTelegramOpen(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// ChannelCard — a row in the channel list with status, switch, action button.
// ============================================================================

function ChannelCard({
  icon,
  title,
  description,
  connected,
  on,
  onToggle,
  alwaysOn = false,
  disabled = false,
  details,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  connected: boolean;
  on: boolean;
  onToggle?: (next: boolean) => void;
  alwaysOn?: boolean;
  disabled?: boolean;
  details?: React.ReactNode;
  action?: React.ReactNode;
}) {
  const t = useTranslations();
  const badge = useMemo(
    () =>
      connected ? (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
          <CheckCircle2 className="w-3.5 h-3.5" />
          {t("billing.channels.statusConnected")}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-xs text-gray-500">
          <CircleSlash className="w-3.5 h-3.5" />
          {t("billing.channels.statusDisconnected")}
        </span>
      ),
    [connected, t],
  );

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 flex-1">
          <div className="p-2 bg-violet-50 text-violet-600 rounded-md">{icon}</div>
          <div className="flex-1">
            <p className="font-semibold text-gray-900">{title}</p>
            <p className="text-sm text-gray-500 mt-0.5">{description}</p>
            <div className="mt-2">{badge}</div>
            {details && <div className="mt-2 space-y-1">{details}</div>}
            {action && <div className="mt-3">{action}</div>}
          </div>
        </div>
        {!alwaysOn && onToggle && (
          <label className="inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={on}
              disabled={disabled}
              onChange={(e) => onToggle(e.target.checked)}
              className="sr-only peer"
            />
            <span className="w-11 h-6 bg-gray-200 peer-checked:bg-violet-600 rounded-full transition-colors relative">
              <span className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform peer-checked:translate-x-5" />
            </span>
          </label>
        )}
        {alwaysOn && (
          <span className="text-xs text-gray-400 italic">
            {t("billing.channels.alwaysOn")}
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// MetaPagePicker — choose the salon's Page when Facebook Login returned several.
// ============================================================================

function MetaPagePicker({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTranslations();
  const [pages, setPages] = useState<Array<{ id: string; name: string; instagramUsername?: string }> | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .getMetaChannelPages()
      .then((list) => {
        setPages(list);
        if (list.length > 0) setSelected(list[0].id);
      })
      .catch((err: any) => setError(err?.message ?? t("billing.channels.metaResultError")));
  }, [t]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiClient.selectMetaChannelPage(selected);
      onDone();
    } catch (err: any) {
      setError(err?.message ?? t("billing.channels.metaResultError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} title={t("billing.channels.metaChooseTitle")}>
      <div className="space-y-4">
        <p className="text-sm text-gray-600">{t("billing.channels.metaChooseIntro")}</p>
        {pages === null && !error && <Loader2 className="w-5 h-5 animate-spin text-gray-400" />}
        {pages && (
          <ul className="space-y-2">
            {pages.map((p) => (
              <li key={p.id}>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="meta-page"
                    value={p.id}
                    checked={selected === p.id}
                    onChange={() => setSelected(p.id)}
                  />
                  <span className="font-medium text-gray-900">{p.name}</span>
                  {p.instagramUsername && (
                    <span className="text-xs text-gray-500">· Instagram @{p.instagramUsername}</span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 inline-flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <div className="flex items-center justify-between pt-2 border-t border-gray-100">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 bg-white hover:bg-gray-50"
          >
            {t("billing.channels.cancel")}
          </button>
          <button
            onClick={submit}
            disabled={!selected || saving}
            className="px-4 py-1.5 text-sm rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 inline-flex items-center gap-2"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {t("billing.channels.metaChooseCta")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ============================================================================
// TelegramWizard — BotFather instructions + token. The backend checks the
// token with Telegram and registers the webhook.
// ============================================================================

function TelegramWizard({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations();
  const [botToken, setBotToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tokenRegex = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
  const canSubmit = tokenRegex.test(botToken.trim());

  const handleSubmit = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiClient.connectTelegramBot(botToken.trim());
      onSaved();
    } catch (err: any) {
      setError(err?.message ?? t("billing.channels.errorSaving"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} title={t("billing.channels.telegramWizardTitle")}>
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          {t("billing.channels.telegramWizardIntro")}
        </p>

        <ol className="list-decimal list-inside text-sm text-gray-700 space-y-1.5">
          <li>
            {t("billing.channels.telegramStep1")}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1 inline-flex items-center text-emerald-700 hover:underline"
            >
              @BotFather
              <ExternalLink className="w-3 h-3 ml-1" />
            </a>
          </li>
          <li>
            {t("billing.channels.telegramStep2")}
            <code className="ml-1 px-1.5 py-0.5 bg-gray-100 rounded text-xs font-mono">
              /newbot
            </code>
          </li>
          <li>{t("billing.channels.telegramStep3")}</li>
          <li>{t("billing.channels.telegramStep4")}</li>
        </ol>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            {t("billing.channels.telegramTokenLabel")}
          </label>
          <input
            type="password"
            autoComplete="off"
            placeholder="123456789:ABC-DEF..."
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-sm font-mono"
          />
          <p className="text-xs text-gray-500 mt-1">{t("billing.channels.telegramTokenHelp")}</p>
          {botToken && !canSubmit && (
            <p className="text-xs text-amber-700 mt-1 inline-flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {t("billing.channels.telegramTokenFormat")}
            </p>
          )}
        </div>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 inline-flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t border-gray-100">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 bg-white hover:bg-gray-50"
          >
            {t("billing.channels.cancel")}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || saving}
            className="px-4 py-1.5 text-sm rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-2"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {t("billing.channels.connect")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ============================================================================
// Reusable bits
// ============================================================================

function Modal({
  onClose,
  title,
  children,
}: {
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full p-6 my-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
            <X className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * LockedCard: shown when the tenant's plan doesn't include the
 * `multichannel` feature key.
 */
function LockedCard({
  message,
  plan,
}: {
  message: string;
  plan: string | null;
}) {
  const t = useTranslations();
  // Esencial tenants can buy the multichannel add-on (€19/mes) without
  // upgrading the whole plan.
  const isEsencial = plan === "esencial";
  // Hand the return path back to this page so the user lands here
  // (already unlocked) after a successful Stripe Checkout.
  const ctaHref = isEsencial
    ? "/dashboard/billing?buy=multichannel&returnTo=/dashboard/settings/channels"
    : "/dashboard/billing";
  const ctaLabel = isEsencial
    ? t("billing.channels.buyAddonCta")
    : t("billing.channels.upgradeCta");
  const helpText = isEsencial
    ? t("billing.channels.buyAddonHelp")
    : t("billing.channels.upgradeHelp");

  return (
    <div className="rounded-lg border border-violet-200 bg-gradient-to-br from-violet-50 to-white p-8 text-center max-w-2xl">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-violet-100 text-violet-600 mb-3">
        <Lock className="w-6 h-6" />
      </div>
      <h2 className="text-lg font-semibold text-gray-900">
        {t("billing.channels.upgradeRequiredTitle")}
      </h2>
      <p className="mt-2 text-sm text-gray-600 max-w-md mx-auto">{message}</p>
      <ul className="mt-5 text-sm text-gray-700 space-y-1.5 inline-block text-left">
        <li className="flex items-start gap-2">
          <MessageSquare className="w-4 h-4 mt-0.5 text-violet-500 flex-shrink-0" />
          {t("billing.channels.upgradeBulletFb")}
        </li>
        <li className="flex items-start gap-2">
          <MessageCircle className="w-4 h-4 mt-0.5 text-violet-500 flex-shrink-0" />
          {t("billing.channels.upgradeBulletIg")}
        </li>
        <li className="flex items-start gap-2">
          <Send className="w-4 h-4 mt-0.5 text-violet-500 flex-shrink-0" />
          {t("billing.channels.upgradeBulletTg")}
        </li>
      </ul>
      {isEsencial && (
        <p className="mt-4 text-sm text-violet-900 font-medium">
          {t("billing.channels.addonPrice")}
        </p>
      )}
      <div className="mt-4">
        <Link
          href={ctaHref}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 transition-colors"
        >
          {ctaLabel}
          <ArrowRight className="w-4 h-4" />
        </Link>
      </div>
      <p className="mt-3 text-xs text-gray-400">{helpText}</p>
    </div>
  );
}

/**
 * What the receptionist did for this salon, counted from the salon's own
 * conversations (`GET /virtual-receptionist/stats`). This tile used to show
 * process-wide counters -- every salon's messages since the last server
 * restart -- as the salon's volume per channel.
 *
 * Shown in every state of the page (also when Multicanal is locked): web and
 * WhatsApp are in every plan with the receptionist. Hidden when the request
 * fails (no receptionist in the plan).
 */
function ReceptionistActivityCard() {
  const t = useTranslations();
  const [stats, setStats] = useState<ReceptionistStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiClient
      .getReceptionistStats(30)
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {
        /* not in the plan, or offline: no tile */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!stats) return null;

  const channels: { key: keyof ReceptionistStats["byChannel"]; label: string }[] = [
    { key: "web", label: "Web" },
    { key: "whatsapp", label: "WhatsApp" },
    { key: "facebook", label: "Messenger" },
    { key: "instagram", label: "Instagram" },
    { key: "telegram", label: "Telegram" },
  ];
  const avg =
    stats.avgResponseMs === null
      ? t("billing.channels.activityNotMeasured")
      : `${(stats.avgResponseMs / 1000).toFixed(1)} s`;
  const tiles: { label: string; value: string | number }[] = [
    { label: t("billing.channels.activityConversations"), value: stats.conversations },
    { label: t("billing.channels.activityClientMessages"), value: stats.messages.fromClients },
    { label: t("billing.channels.activityBookings"), value: stats.bookings },
    { label: t("billing.channels.activityHandedOff"), value: stats.handedOff },
    { label: t("billing.channels.activityAvgResponse"), value: avg },
  ];

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm">
      <p className="font-medium text-gray-700">
        {t("billing.channels.activityTitle", { days: stats.days })}
      </p>
      {stats.conversations === 0 ? (
        <p className="mt-2 text-gray-500">{t("billing.channels.activityEmpty")}</p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-3 text-center">
            {tiles.map(({ label, value }) => (
              <div key={label} className="rounded border border-gray-100 bg-gray-50 p-2">
                <p className="text-xl font-semibold text-gray-900">{value}</p>
                <p className="mt-1 text-[11px] text-gray-500">{label}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-gray-500">
            {t("billing.channels.activityByChannel")}:{" "}
            {channels
              .filter(({ key }) => stats.byChannel[key] > 0)
              .map(({ key, label }) => `${label} ${stats.byChannel[key]}`)
              .join(" · ")}
          </p>
        </>
      )}
    </div>
  );
}

