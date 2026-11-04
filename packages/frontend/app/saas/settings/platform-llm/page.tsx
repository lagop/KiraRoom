"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Key, Save, Check, AlertCircle, Eye, EyeOff, FlaskConical, Trash2 } from "lucide-react";
import apiClient, { PlatformLlmConfig } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useTranslations } from "@/lib/use-translation";

// Anthropic only (audit 8 D9). Same ids as the backend's CLAUDE_MODELS
// (virtual-receptionist/providers/anthropic-models.ts), which the server
// enforces at save.
const PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-haiku-5-5";
const CLAUDE_MODELS: Array<{ id: string; name: string }> = [
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  // Legacy: ten times the price of Haiku 5.5.
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5 (legacy)" },
];
const isClaudeModel = (m: string) => CLAUDE_MODELS.some((x) => x.id === m);

/**
 * The AI provider of the receptionist and the copilot, for the saas_owner.
 * The key is write-only. Changing anything needs two-step sign-in and is
 * audited; "Probar conexión" tests what is typed without saving it, and
 * "Quitar la clave" goes back to the server's ANTHROPIC_API_KEY.
 */
export default function PlatformLlmConfigPage() {
  const t = useTranslations();
  const tr = (key: string, vars?: Record<string, string | number>) => {
    const v = t(key);
    if (!vars) return v;
    return Object.entries(vars).reduce((acc, [k, val]) => acc.split(`{${k}}`).join(String(val)), v);
  };
  const { toast } = useToast();
  const [cfg, setCfg] = useState<PlatformLlmConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const [defaultModel, setDefaultModel] = useState(DEFAULT_MODEL);
  // A row saved before D9 (another provider or model): runs on the default.
  const [storedOther, setStoredOther] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  // P2A-anthropic-workspace: the "Descubrir" list for the typed key.
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name?: string; default?: boolean }>>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoverMsg, setDiscoverMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function show(next: PlatformLlmConfig) {
    setCfg(next);
    const valid = next.provider === PROVIDER && isClaudeModel(next.defaultModel);
    setStoredOther(valid ? null : `${next.provider} / ${next.defaultModel}`);
    setDefaultModel(valid ? next.defaultModel : DEFAULT_MODEL);
    setWorkspaceId(next.workspaceId ?? "");
    // The key is never received back.
    setApiKey("");
  }

  async function load() {
    setLoading(true);
    try {
      show(await apiClient.getPlatformLlmConfig());
    } catch (err: any) {
      toast({ title: err?.message ?? tr("platform_llm.load_error"), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const next = await apiClient.updatePlatformLlmConfig({
        provider: PROVIDER,
        defaultModel,
        apiKey: apiKey.trim() || undefined,
        workspaceId: workspaceId.trim() || null,
      });
      show(next);
      setTestResult(null);
      toast({
        title: tr("platform_llm.save_success"),
        description: next.hasKey ? tr("platform_llm.save_success_with_key") : tr("platform_llm.save_success_no_key"),
      });
    } catch (err: any) {
      setError(err?.message ?? tr("platform_llm.save_error"));
    } finally {
      setSaving(false);
    }
  }

  async function clearKey() {
    setSaving(true);
    setError(null);
    try {
      show(await apiClient.clearPlatformLlmKey());
      setConfirmClear(false);
      setTestResult(null);
      toast({ title: tr("platform_llm.clear_success") });
    } catch (err: any) {
      setConfirmClear(false);
      setError(err?.message ?? tr("platform_llm.save_error"));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      // What is typed, without saving it; empty fields use what is saved.
      const res = await apiClient.testPlatformLlmConnection({
        provider: PROVIDER,
        defaultModel: defaultModel.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
        workspaceId: workspaceId.trim() || null,
      });
      setTestResult({ ok: res.ok, message: res.latencyMs ? `${res.message} (${res.latencyMs} ms)` : res.message });
    } catch (err: any) {
      setTestResult({ ok: false, message: err?.message ?? "Error" });
    } finally {
      setTesting(false);
    }
  }

  async function discoverWorkspaces() {
    setWorkspaces([]);
    setDiscoverMsg(null);
    if (!apiKey.trim()) {
      setDiscoverMsg({ ok: false, text: tr("platform_llm.discover_need_key") });
      return;
    }
    setDiscovering(true);
    try {
      const res = await apiClient.discoverAnthropicWorkspaces(apiKey.trim());
      if (!res.ok) {
        setDiscoverMsg({ ok: false, text: res.message ?? "Error" });
      } else if (res.workspaces.length === 0) {
        setDiscoverMsg({ ok: true, text: tr("platform_llm.discover_none") });
      } else if (res.workspaces.length === 1) {
        setWorkspaceId(res.workspaces[0].id);
        setDiscoverMsg({ ok: true, text: `${res.workspaces[0].name ?? res.workspaces[0].id}` });
      } else {
        setWorkspaces(res.workspaces);
        setDiscoverMsg({ ok: true, text: tr("platform_llm.discover_found") });
      }
    } catch (err: any) {
      setDiscoverMsg({ ok: false, text: err?.message ?? "Error" });
    } finally {
      setDiscovering(false);
    }
  }

  if (loading) {
    return <div className="text-gray-500">Cargando…</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t("platform_llm.title")}</h1>
        <p className="text-gray-500 mt-1 max-w-2xl">{t("platform_llm.subtitle")}</p>
      </div>

      {cfg?.keyState === "unreadable" && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{t("platform_llm.api_key_unreadable")}</span>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t("platform_llm.provider_label")}</label>
            <p className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-700">
              {t("platform_llm.provider_anthropic")}
            </p>
            <p className="text-xs text-gray-500 mt-1">{t("platform_llm.provider_only_anthropic")}</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t("platform_llm.model_label")}</label>
            <select
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
            >
              {CLAUDE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.id})
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">{t("platform_llm.model_recommended")}</p>
            {storedOther && (
              <p className="text-xs text-amber-700 mt-1">
                {tr("platform_llm.stored_other_provider", { stored: storedOther, model: DEFAULT_MODEL })}
              </p>
            )}
          </div>

          <div className="md:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
              <label className="block text-sm font-medium text-gray-700">
                <Key className="inline w-4 h-4 mr-1" />
                {t("platform_llm.api_key_label")}
              </label>
              {(cfg?.keyState === "set" || cfg?.keyState === "unreadable") && (
                <button
                  type="button"
                  onClick={() => setConfirmClear(true)}
                  className="text-xs text-gray-500 underline hover:text-gray-700 inline-flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" />
                  {t("platform_llm.actions_clear")}
                </button>
              )}
            </div>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  cfg?.hasKey
                    ? `••••••••••••${cfg.apiKeyLastFour}  (${t("platform_llm.api_key_placeholder_existing")})`
                    : t("platform_llm.api_key_placeholder_empty")
                }
                autoComplete="off"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 pr-10 text-sm font-mono"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700 p-1"
                title={showKey ? t("platform_llm.hide_key") : t("platform_llm.show_key")}
                aria-label={showKey ? t("platform_llm.hide_key") : t("platform_llm.show_key")}
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className={`text-xs mt-1 ${cfg?.keyState === "unreadable" || cfg?.inUse === "none" ? "text-red-600" : "text-gray-500"}`}>
              {cfg?.keyState === "set" ? (
                <>
                  {t("platform_llm.api_key_active")} <code className="bg-gray-100 px-1 rounded">{cfg.apiKeyMasked}</code>
                  {cfg.updatedAt && (
                    <>
                      {" "}
                      ·{" "}
                      {tr("platform_llm.api_key_saved_at", {
                        date: new Date(cfg.updatedAt).toLocaleString("es-ES"),
                      })}
                      {cfg.updatedBy ? ` (${cfg.updatedBy})` : ""}
                    </>
                  )}
                  {cfg.serverKey && <> {t("platform_llm.api_key_server_also")}</>}
                </>
              ) : cfg?.keyState === "unreadable" ? (
                t("platform_llm.api_key_unreadable")
              ) : cfg?.serverKey ? (
                t("platform_llm.api_key_no_key_server")
              ) : (
                t("platform_llm.api_key_no_key_none")
              )}
            </p>
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">{t("platform_llm.workspace_id_label")}</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
                className="flex-1 min-w-0 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
              />
              <button
                type="button"
                onClick={discoverWorkspaces}
                disabled={discovering}
                className="bg-white border border-gray-300 text-gray-700 px-3 py-2 rounded-lg hover:bg-gray-50 disabled:opacity-50 inline-flex items-center gap-2 text-sm whitespace-nowrap"
              >
                <Key className="w-4 h-4" />
                {discovering ? t("platform_llm.discover_searching") : t("platform_llm.discover")}
              </button>
            </div>
            {discoverMsg && (
              <p className={`text-xs mt-1 ${discoverMsg.ok ? "text-gray-700" : "text-red-700"}`}>{discoverMsg.text}</p>
            )}
            {workspaces.length > 1 && (
              <div className="mt-2 border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-48 overflow-y-auto">
                {workspaces.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => setWorkspaceId(w.id)}
                    className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center justify-between gap-2"
                  >
                    <span className="text-sm min-w-0 truncate">
                      <span className="font-mono text-xs text-gray-700">{w.id}</span>
                      {w.name && <span className="ml-2 text-gray-500">{w.name}</span>}
                    </span>
                    {w.default && (
                      <span className="text-xs px-2 py-0.5 bg-purple-100 text-purple-700 rounded">
                        {t("platform_llm.discover_default")}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
            <p className="text-xs text-gray-500 mt-1">{t("platform_llm.workspace_id_help")}</p>
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-600 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              {error}
              {/dos pasos/.test(error) && (
                <>
                  {" "}
                  <Link href="/saas/seguridad" className="underline">
                    Ir a Seguridad
                  </Link>
                </>
              )}
            </span>
          </p>
        )}

        <div className="flex flex-wrap justify-between items-center gap-3 pt-3 border-t border-gray-100">
          <button
            onClick={test}
            disabled={testing}
            className="bg-white border border-gray-300 text-gray-700 px-3 py-2 rounded-lg hover:bg-gray-50 disabled:opacity-50 inline-flex items-center gap-2 text-sm"
          >
            <FlaskConical className="w-4 h-4" />
            {testing ? t("platform_llm.actions_testing") : t("platform_llm.actions_test")}
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 disabled:opacity-50 inline-flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            {saving ? t("platform_llm.actions_saving") : t("platform_llm.actions_save")}
          </button>
        </div>
        <p className="text-xs text-gray-500">{t("platform_llm.test_typed_hint")}</p>

        {testResult && (
          <div
            className={`text-sm p-3 rounded-lg flex items-start gap-2 ${
              testResult.ok ? "bg-green-50 text-green-800 border border-green-200" : "bg-red-50 text-red-800 border border-red-200"
            }`}
          >
            {testResult.ok ? <Check className="w-4 h-4 mt-0.5" /> : <AlertCircle className="w-4 h-4 mt-0.5" />}
            <span className="break-words min-w-0">{testResult.message}</span>
          </div>
        )}
      </div>

      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800 flex items-start gap-2">
        <AlertCircle className="w-4 h-4 mt-0.5" />
        <div>{t("platform_llm.security_notice")}</div>
      </div>

      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-sm text-gray-600">
        <h3 className="font-semibold text-gray-800 mb-2">{t("platform_llm.how_to_get_title")}</h3>
        <ul className="space-y-1 list-disc pl-5">
          <li>
            <strong>{t("platform_llm.how_to_get_anthropic")}</strong>{" "}
            <a className="text-purple-700 underline" href="https://console.anthropic.com" target="_blank" rel="noreferrer">
              console.anthropic.com
            </a>{" "}
            → Settings → API Keys → Create Key.
          </li>
        </ul>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title={t("platform_llm.clear_title")}
        description={cfg?.serverKey ? t("platform_llm.clear_description_server") : t("platform_llm.clear_description_none")}
        confirmLabel={t("platform_llm.actions_clear")}
        destructive
        loading={saving}
        onCancel={() => setConfirmClear(false)}
        onConfirm={clearKey}
      />
    </div>
  );
}
