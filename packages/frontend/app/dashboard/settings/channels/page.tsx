'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "@/lib/use-translation";
import apiClient from "@/lib/api";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  CircleSlash,
  Copy,
  ExternalLink,
  Info,
  Loader2,
  Lock,
  MessageCircle,
  MessageSquare,
  Send,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";

/**
 * P2A-receptionist-v2 H-4 frontend: channel configuration for the
 * Virtual Receptionist.
 *
 * Four channels:
 *   1. Web (always on, no configuration)
 *   2. Facebook Messenger
 *   3. Instagram DMs
 *   4. Telegram
 *
 * Channels 2 and 3 share a single Meta connection (pageId + accessToken)
 * so they are configured together via one wizard.
 *
 * State is persisted on `Tenant.features.multichannel.*` (JSON) through
 * `PUT /virtual-receptionist/channels/config`. Secrets are stored as
 * written; the GET endpoint redacts them.
 */

type ChannelName = "facebook" | "instagram" | "telegram";

type ChannelsConfig = {
  enabled: boolean;
  enabledChannels: string[];
  meta: {
    configured: boolean;
    pageId?: string;
    instagramBusinessAccountId?: string;
    linkedChats: string[];
    webhookSecret?: string;
    hasAccessToken: boolean;
  } | null;
  telegram: {
    configured: boolean;
    botUsername?: string;
    linkedChats: string[];
    hasBotToken: boolean;
  } | null;
};

type WizardKind = null | "meta" | "telegram";

/**
 * When the backend returns 403 FEATURE_NOT_IN_PLAN (the `multichannel`
 * feature key is not in the tenant's plan), we render an upgrade CTA
 * instead of the wizard. The webhook controllers also drop messages
 * for tenants without the feature, so this is the canonical UI gate.
 *
 * The CTA branches on the tenant's plan:
 *   - esencial  → "Buy the Multicanal add-on (€19/mes)" → Stripe
 *   - anything else (defensive) → "Sube de plan" → billing
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
  telegram: null,
};

export default function ChannelsSettingsPage() {
  const t = useTranslations();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<ChannelsConfig>(EMPTY_CONFIG);
  const [wizard, setWizard] = useState<WizardKind>(null);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  // H-4: per-channel volume counters. Polled every 30s so the tile
  // stays roughly fresh without a websocket.
  const [metrics, setMetrics] = useState<{
    inbound: Record<string, number>;
    outbound: Record<string, { ok: number; skipped: number; error: number }>;
    gateBlocked: Record<
      string,
      { no_feature: number; lookup_error: number }
    >;
  } | null>(null);

  const refreshMetrics = useCallback(async () => {
    try {
      const m = await apiClient.getChannelsMetrics();
      setMetrics(m);
    } catch {
      // Metrics are best-effort; don't surface errors here.
    }
  }, []);

  const tRef = useRef(t);
  tRef.current = t;

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const [data, tenant] = await Promise.all([
        apiClient.getChannelsConfig(),
        apiClient.getTenant().catch(() => null),
      ]);
      const plan = (tenant?.plan as string | undefined) ?? null;
      setConfig(data ?? EMPTY_CONFIG);
      setState({ kind: "ready", plan });
      refreshMetrics();
    } catch (err: any) {
      const code = err?.response?.data?.code;
      if (err?.response?.status === 403 && code === "FEATURE_NOT_IN_PLAN") {
        // Fetch the plan even when gated so the CTA can branch.
        const tenant = await apiClient.getTenant().catch(() => null);
        const plan = (tenant?.plan as string | undefined) ?? null;
        setState({
          kind: "locked",
          message:
            err?.response?.data?.message ??
            tRef.current("billing.channels.upgradeRequiredMessage"),
          plan,
        });
        return;
      }
      setState({
        kind: "error",
        message: err?.message ?? tRef.current("billing.channels.errorLoading"),
      });
    }
  }, [refreshMetrics]);

  useEffect(() => {
    load();
    // load is intentionally only triggered on mount; subsequent renders must
    // not refetch config or the page enters a render loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isOn = (name: ChannelName) => config.enabledChannels.includes(name);

  const toggle = async (name: ChannelName, next: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const set = new Set(config.enabledChannels);
      if (next) {
        set.add(name);
        if (name === "facebook") set.add("instagram");
        if (name === "instagram") set.add("facebook");
      } else {
        set.delete(name);
        if (name === "facebook") set.delete("instagram");
        if (name === "instagram") set.delete("facebook");
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

  const metaConnected = !!config.meta?.configured;
  const telegramConnected = !!config.telegram?.configured;
  const webhookBase =
    typeof window !== "undefined" ? window.location.origin : "";
  const metaWebhookUrl = `${webhookBase}/api/v1/channels/webhooks/meta`;
  const telegramWebhookUrl = `${webhookBase}/api/v1/channels/webhooks/telegram`;

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
      </header>

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
          <button
            onClick={load}
            className="ml-auto underline text-xs"
          >
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
            status="connected"
            on={true}
            disabled
          />

          {/* WHATSAPP — always-on, configured elsewhere */}
          <ChannelCard
            icon={<MessageSquare className="w-5 h-5" />}
            title={t("billing.channels.whatsappTitle")}
            description={t("billing.channels.whatsappDescription")}
            status="connected"
            on={true}
            disabled
          />

          {/* META (FB + IG) */}
          <ChannelCard
            icon={<MessageSquare className="w-5 h-5" />}
            title={t("billing.channels.metaTitle")}
            description={t("billing.channels.metaDescription")}
            status={metaConnected ? "connected" : "disconnected"}
            on={isOn("facebook") || isOn("instagram")}
            onToggle={(next) => toggle("facebook", next)}
            action={
              <button
                onClick={() => setWizard("meta")}
                className="px-3 py-1.5 text-xs rounded-md border border-violet-300 text-violet-700 hover:bg-violet-50 inline-flex items-center gap-1"
              >
                {metaConnected
                  ? t("billing.channels.manage")
                  : t("billing.channels.connect")}
                <ChevronRight className="w-3 h-3" />
              </button>
            }
          />

          {/* TELEGRAM */}
          <ChannelCard
            icon={<Send className="w-5 h-5" />}
            title={t("billing.channels.telegramTitle")}
            description={t("billing.channels.telegramDescription")}
            status={telegramConnected ? "connected" : "disconnected"}
            on={isOn("telegram")}
            onToggle={(next) => toggle("telegram", next)}
            action={
              <button
                onClick={() => setWizard("telegram")}
                className="px-3 py-1.5 text-xs rounded-md border border-emerald-300 text-emerald-700 hover:bg-emerald-50 inline-flex items-center gap-1"
              >
                {telegramConnected
                  ? t("billing.channels.manage")
                  : t("billing.channels.connect")}
                <ChevronRight className="w-3 h-3" />
              </button>
            }
          />

          {/* Webhook URLs (only when configured) */}
          {metaConnected && (
            <WebhookCard
              title={t("billing.channels.webhookUrlLabel")}
              url={metaWebhookUrl}
              hint={t("billing.channels.webhookUrlHint")}
              secret={config.meta?.webhookSecret}
            />
          )}
          {telegramConnected && (
            <WebhookCard
              title={t("billing.channels.telegramWebhookLabel")}
              url={telegramWebhookUrl}
              hint={t("billing.channels.telegramWebhookHint")}
              secret={null}
            />
          )}

          {/* H-4: per-channel volume counters (process-local) */}
          <ChannelsMetricsCard />

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

      {/* Meta wizard modal */}
      {wizard === "meta" && (
        <MetaWizard
          initial={config.meta}
          onClose={() => setWizard(null)}
          onSaved={(updated) => {
            setConfig(updated);
            setWizard(null);
          }}
        />
      )}

      {/* Telegram wizard modal */}
      {wizard === "telegram" && (
        <TelegramWizard
          initial={config.telegram}
          onClose={() => setWizard(null)}
          onSaved={(updated) => {
            setConfig(updated);
            setWizard(null);
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
  status,
  on,
  onToggle,
  disabled = false,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  status: "connected" | "pending" | "disconnected";
  on: boolean;
  onToggle?: (next: boolean) => void;
  disabled?: boolean;
  action?: React.ReactNode;
}) {
  const t = useTranslations();
  const badge = useMemo(() => {
    if (status === "connected") {
      return (
        <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
          <CheckCircle2 className="w-3.5 h-3.5" />
          {t("billing.channels.statusConnected")}
        </span>
      );
    }
    if (status === "pending") {
      return (
        <span className="inline-flex items-center gap-1 text-xs text-amber-700">
          <CircleDashed className="w-3.5 h-3.5" />
          {t("billing.channels.statusPending")}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 text-xs text-gray-500">
<CircleSlash className="w-3.5 h-3.5" />
          {t("billing.channels.statusDisconnected")}
      </span>
    );
  }, [status, t]);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 flex-1">
          <div className="p-2 bg-violet-50 text-violet-600 rounded-md">{icon}</div>
          <div className="flex-1">
            <p className="font-semibold text-gray-900">{title}</p>
            <p className="text-sm text-gray-500 mt-0.5">{description}</p>
            <div className="mt-2">{badge}</div>
            {action && <div className="mt-3">{action}</div>}
          </div>
        </div>
        {!disabled && onToggle && (
          <label className="inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={on}
              onChange={(e) => onToggle(e.target.checked)}
              className="sr-only peer"
            />
            <span className="w-11 h-6 bg-gray-200 peer-checked:bg-violet-600 rounded-full transition-colors relative">
              <span className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform peer-checked:translate-x-5" />
            </span>
          </label>
        )}
        {disabled && (
          <span className="text-xs text-gray-400 italic">
            {t("billing.channels.alwaysOn")}
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// MetaWizard — modal that walks through the 4 Meta requirements + paste
// pageId + pageAccessToken. Saves on the last step.
// ============================================================================

function MetaWizard({
  initial,
  onClose,
  onSaved,
}: {
  initial: ChannelsConfig["meta"];
  onClose: () => void;
  onSaved: (next: ChannelsConfig) => void;
}) {
  const t = useTranslations();
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const [pageId, setPageId] = useState(initial?.pageId ?? "");
  const [accessToken, setAccessToken] = useState("");
  const [webhookSecret, setWebhookSecret] = useState(
    initial?.webhookSecret ?? "",
  );
  const [igBusinessId, setIgBusinessId] = useState(
    initial?.instagramBusinessAccountId ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = useMemo(() => {
    if (!pageId.match(/^\d{6,32}$/)) return false;
    // Access token is required only when there isn't one stored yet.
    if (!initial?.hasAccessToken && !accessToken) return false;
    if (accessToken && accessToken.length < 20) return false;
    return true;
  }, [pageId, accessToken, initial?.hasAccessToken]);

  const handleSubmit = async () => {
    setSaving(true);
    setError(null);
    try {
      const meta: {
        pageId: string;
        pageAccessToken?: string;
        instagramBusinessAccountId?: string;
        webhookSecret?: string;
      } = { pageId };
      // Only send the access token if the user typed a new one. The
      // server preserves the previous token when the field is omitted.
      if (accessToken) meta.pageAccessToken = accessToken;
      if (igBusinessId) meta.instagramBusinessAccountId = igBusinessId;
      if (webhookSecret) meta.webhookSecret = webhookSecret;

      const updated = await apiClient.updateChannelsConfig({
        enabledChannels: ["web", "facebook", "instagram"],
        meta,
      });
      onSaved(updated);
    } catch (err: any) {
      setError(err?.message ?? t("billing.channels.errorSaving"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} title={t("billing.channels.metaWizardTitle")}>
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          {t("billing.channels.metaWizardIntro")}
        </p>

        <ol className="space-y-2 text-sm">
          <Step
            done={step > 0}
            number={1}
            onClick={() => setStep(0)}
            active={step === 0}
          >
            {t("billing.channels.metaStep1")}
            <a
              href="https://www.facebook.com/pages/create"
              target="_blank"
              rel="noopener noreferrer"
              className="ml-2 inline-flex items-center text-violet-700 hover:underline"
            >
              facebook.com/pages/create
              <ExternalLink className="w-3 h-3 ml-1" />
            </a>
          </Step>
          <Step
            done={step > 1}
            number={2}
            onClick={() => setStep(1)}
            active={step === 1}
            disabled={step === 0}
          >
            {t("billing.channels.metaStep2")}
            <a
              href="https://www.instagram.com/account/type_business"
              target="_blank"
              rel="noopener noreferrer"
              className="ml-2 inline-flex items-center text-violet-700 hover:underline"
            >
              instagram.com/account/type_business
              <ExternalLink className="w-3 h-3 ml-1" />
            </a>
          </Step>
          <Step
            done={step > 2}
            number={3}
            onClick={() => setStep(2)}
            active={step === 2}
            disabled={step <= 1}
          >
            {t("billing.channels.metaStep3")}
          </Step>
        </ol>

        {step === 3 && (
          <div className="rounded-md border border-violet-200 bg-violet-50 p-4 space-y-3">
            <p className="text-sm font-medium text-violet-900 flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" />
              {t("billing.channels.metaStep4Title")}
            </p>
            <p className="text-xs text-violet-800">
              {t("billing.channels.metaStep4Hint")}
            </p>
            <Field
              label={t("billing.channels.metaPageIdLabel")}
              help={t("billing.channels.metaPageIdHelp")}
            >
              <input
                type="text"
                inputMode="numeric"
                placeholder="123456789012345"
                value={pageId}
                onChange={(e) => setPageId(e.target.value.replace(/\D/g, ""))}
                className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-sm font-mono"
              />
            </Field>
            <Field
              label={t("billing.channels.metaAccessTokenLabel")}
              help={
                initial?.hasAccessToken
                  ? t("billing.channels.metaAccessTokenKeep")
                  : t("billing.channels.metaAccessTokenHelp")
              }
            >
              <input
                type="password"
                placeholder={initial?.hasAccessToken ? "••••••••" : "EAA..."}
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-sm font-mono"
              />
            </Field>
            <Field
              label={t("billing.channels.metaIgBusinessIdLabel")}
              help={t("billing.channels.metaIgBusinessIdHelp")}
            >
              <input
                type="text"
                inputMode="numeric"
                placeholder="17841401234567890"
                value={igBusinessId}
                onChange={(e) =>
                  setIgBusinessId(e.target.value.replace(/\D/g, ""))
                }
                className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-sm font-mono"
              />
            </Field>
            <Field
              label={t("billing.channels.metaWebhookSecretLabel")}
              help={t("billing.channels.metaWebhookSecretHelp")}
            >
              <input
                type="text"
                placeholder={t(
                  "billing.channels.metaWebhookSecretPlaceholder",
                )}
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-sm font-mono"
              />
            </Field>
          </div>
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
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((step - 1) as 0 | 1 | 2 | 3)}
                className="px-3 py-1.5 text-sm rounded border border-gray-300 bg-white hover:bg-gray-50"
              >
                {t("billing.channels.back")}
              </button>
            )}
            {step < 3 ? (
              <button
                onClick={() => setStep((step + 1) as 0 | 1 | 2 | 3)}
                className="px-4 py-1.5 text-sm rounded bg-violet-600 text-white hover:bg-violet-700"
              >
                {t("billing.channels.next")}
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={!canSubmit || saving}
                className="px-4 py-1.5 text-sm rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {initial?.configured
                  ? t("billing.channels.save")
                  : t("billing.channels.connect")}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ============================================================================
// TelegramWizard — modal with BotFather instructions + bot token paste.
// ============================================================================

function TelegramWizard({
  initial,
  onClose,
  onSaved,
}: {
  initial: ChannelsConfig["telegram"];
  onClose: () => void;
  onSaved: (next: ChannelsConfig) => void;
}) {
  const t = useTranslations();
  const [botToken, setBotToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tokenRegex = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
  const canSubmit =
    (!!initial?.hasBotToken && !botToken) || tokenRegex.test(botToken);

  const handleSubmit = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: { botToken?: string } = {};
      // Send the token only if the user typed a new one (keeps existing).
      if (botToken) payload.botToken = botToken;
      const updated = await apiClient.updateChannelsConfig({
        enabledChannels: ["web", "telegram"],
        telegram: payload,
      });
      onSaved(updated);
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

        <Field
          label={t("billing.channels.telegramTokenLabel")}
          help={
            initial?.hasBotToken
              ? t("billing.channels.telegramTokenKeep")
              : t("billing.channels.telegramTokenHelp")
          }
        >
          <input
            type="password"
            placeholder={initial?.hasBotToken ? "••••••••" : "123456:ABC-DEF..."}
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            className="w-full px-2.5 py-1.5 border border-gray-300 rounded text-sm font-mono"
          />
          {botToken && !tokenRegex.test(botToken) && (
            <p className="text-xs text-amber-700 mt-1 inline-flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              {t("billing.channels.telegramTokenFormat")}
            </p>
          )}
        </Field>

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
            {initial?.configured
              ? t("billing.channels.save")
              : t("billing.channels.connect")}
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
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Step({
  done,
  number,
  onClick,
  active,
  disabled = false,
  children,
}: {
  done: boolean;
  number: number;
  onClick: () => void;
  active: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={
          "w-full text-left flex items-start gap-2 p-2 rounded-md transition-colors " +
          (disabled
            ? "cursor-default"
            : active
              ? "bg-violet-100"
              : "hover:bg-gray-50")
        }
      >
        <span
          className={
            "mt-0.5 w-5 h-5 rounded-full flex items-center justify-center text-xs font-medium flex-shrink-0 " +
            (done
              ? "bg-violet-600 text-white"
              : active
                ? "bg-violet-600 text-white"
                : "bg-violet-100 text-violet-700")
          }
        >
          {done ? "✓" : number}
        </span>
        <span
          className={
            "flex-1 text-sm " +
            (active ? "text-violet-900 font-medium" : "text-gray-700")
          }
        >
          {children}
        </span>
      </button>
    </li>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">
        {label}
      </label>
      {children}
      {help && <p className="text-xs text-gray-500 mt-1">{help}</p>}
    </div>
  );
}

function WebhookCard({
  title,
  url,
  hint,
  secret,
}: {
  title: string;
  url: string;
  hint?: string;
  secret?: string | null;
}) {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard not available
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm">
      <p className="font-medium text-gray-700 flex items-center gap-2">
        <Info className="w-4 h-4" />
        {title}
      </p>
      <div className="mt-2 flex items-start gap-2">
        <code className="flex-1 p-2 bg-gray-50 rounded text-xs font-mono text-gray-800 break-all">
          {url}
        </code>
        <button
          onClick={() => copy(url)}
          className="px-2 py-1.5 text-xs rounded border border-gray-300 bg-white hover:bg-gray-50 inline-flex items-center gap-1"
          title={t("billing.channels.copy")}
        >
          <Copy className="w-3 h-3" />
          {copied ? t("billing.channels.copied") : t("billing.channels.copy")}
        </button>
      </div>
      {secret && (
        <>
          <p className="mt-3 text-xs font-medium text-gray-700">
            {t("billing.channels.webhookSecretLabel")}
          </p>
          <div className="mt-1 flex items-start gap-2">
            <code className="flex-1 p-2 bg-gray-50 rounded text-xs font-mono text-gray-800 break-all">
              {secret}
            </code>
            <button
              onClick={() => copy(secret)}
              className="px-2 py-1.5 text-xs rounded border border-gray-300 bg-white hover:bg-gray-50 inline-flex items-center gap-1"
            >
              <Copy className="w-3 h-3" />
              {copied ? t("billing.channels.copied") : t("billing.channels.copy")}
            </button>
          </div>
        </>
      )}
      {hint && <p className="mt-2 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

/**
 * LockedCard: shown when the tenant's plan doesn't include the
 * `multichannel` feature key. Replaces the wizard with an upgrade CTA
 * pointing to the billing dashboard. Same shape as the
 * `analytics.upgrade_required_message` upgrade flow.
 */
function LockedCard({
  message,
  plan,
}: {
  message: string;
  plan: string | null;
}) {
  const t = useTranslations();
  // H-4: Esencial tenants can buy the multichannel add-on (€19/mes)
  // without upgrading the whole plan. Pro/Empresa tenants shouldn't
  // hit this branch (the gate already filters them at the matrix
  // level), but we keep a fallback CTA for any defensive case.
  const isEsencial = plan === "esencial";
  // Hand the return path back to the wizard so the user lands here
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
      <p className="mt-2 text-sm text-gray-600 max-w-md mx-auto">
        {message}
      </p>
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
      <p className="mt-3 text-xs text-gray-400">
        {helpText}
      </p>
    </div>
  );
}

/**
 * H-4: small live-counter tile. Reads the JSON breakdown from
 * `GET /virtual-receptionist/channels/metrics` and shows inbound /
 * outbound / gate-blocked counts per channel. Polled every 30s.
 */
function ChannelsMetricsCard() {
  const t = useTranslations();
  const [metrics, setMetrics] = useState<{
    inbound: Record<string, number>;
    outbound: Record<string, { ok: number; skipped: number; error: number }>;
    gateBlocked: Record<
      string,
      { no_feature: number; lookup_error: number }
    >;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const m = await apiClient.getChannelsMetrics();
        if (!cancelled) setMetrics(m);
      } catch {
        /* best-effort */
      }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
  if (!metrics) return null;
  const channels: { key: string; label: string }[] = [
    { key: "facebook", label: "Messenger" },
    { key: "instagram", label: "Instagram" },
    { key: "telegram", label: "Telegram" },
  ];
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm">
      <p className="font-medium text-gray-700 flex items-center gap-2">
        {t("billing.channels.metricsTitle")}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-3 text-center">
        {channels.map(({ key, label }) => {
          const inb = metrics.inbound[key] ?? 0;
          const out = metrics.outbound[key] ?? { ok: 0, skipped: 0, error: 0 };
          const blocked = metrics.gateBlocked[key] ?? {
            no_feature: 0,
            lookup_error: 0,
          };
          return (
            <div
              key={key}
              className="rounded border border-gray-100 bg-gray-50 p-2"
            >
              <p className="text-xs font-medium text-gray-500">{label}</p>
              <p className="mt-1 text-2xl font-semibold text-gray-900">{inb}</p>
              <p className="text-[10px] uppercase tracking-wide text-gray-400">
                {t("billing.channels.metricsInbound")}
              </p>
              <div className="mt-2 text-[11px] text-gray-500 flex justify-around">
                <span>
                  <span className="text-emerald-600 font-semibold">
                    {out.ok}
                  </span>{" "}
                  {t("billing.channels.metricsOut")}
                </span>
                <span>
                  <span className="text-red-600 font-semibold">
                    {out.error + blocked.no_feature + blocked.lookup_error}
                  </span>{" "}
                  {t("billing.channels.metricsBlocked")}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}