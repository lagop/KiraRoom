"use client";

import { useEffect, useState } from "react";
import {
  Key,
  Save,
  Check,
  AlertCircle,
  Eye,
  EyeOff,
  FlaskConical,
} from "lucide-react";
import apiClient, { PlatformLlmConfig } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { useTranslations } from "@/lib/use-translation";

export default function PlatformLlmConfigPage() {
  const t = useTranslations();
  const tr = (key: string, vars?: Record<string, string | number>) => {
    const v = t(key);
    if (!vars) return v;
    return Object.entries(vars).reduce(
      (acc, [k, val]) => acc.split(`{${k}}`).join(String(val)),
      v,
    );
  };

const PROVIDER_OPTIONS = [
  { value: "anthropic", label: "Anthropic (Claude Haiku 4.5, Sonnet 4.5, Opus 4.5)" },
  { value: "openai", label: "OpenAI (GPT-4o, GPT-4o-mini)" },
  { value: "google", label: "Google Gemini" },
  { value: "MiniMax", label: "MiniMax" },
];

const MODEL_PRESETS: Record<string, string[]> = {
  anthropic: [
    "claude-haiku-4-5",
    "claude-sonnet-4-5",
    "claude-opus-4-5",
  ],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"],
  google: ["gemini-2.5-pro", "gemini-2.5-flash"],
  MiniMax: ["MiniMax-M3"],
};
  const { toast } = useToast();
  const [cfg, setCfg] = useState<PlatformLlmConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const [provider, setProvider] = useState("anthropic");
  const [defaultModel, setDefaultModel] = useState("claude-haiku-4-5");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  // P2A-anthropic-workspace: state for the "discover workspace ID" UI.
  const [workspaces, setWorkspaces] = useState<
    Array<{ id: string; name?: string; default?: boolean }>
  >([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoverMsg, setDiscoverMsg] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const next = await apiClient.getPlatformLlmConfig();
      setCfg(next);
      setProvider(next.provider);
      setDefaultModel(next.defaultModel);
      setBaseUrl(next.baseUrl ?? "");
      setWorkspaceId(next.workspaceId ?? "");
      // Don't populate apiKey — we never receive the plaintext back.
    } catch (err: any) {
      toast({
        title: err?.message ?? tr("platform_llm.load_error"),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function save() {
    setSaving(true);
    try {
      const next = await apiClient.updatePlatformLlmConfig({
        provider,
        defaultModel,
        apiKey: apiKey.trim() || undefined,
        baseUrl: baseUrl.trim() || null,
        workspaceId: workspaceId.trim() || null,
      });
      setCfg(next);
      setApiKey("");
      toast({
        title: tr("platform_llm.save_success"),
        description: next.hasKey
          ? tr("platform_llm.save_success_with_key")
          : tr("platform_llm.save_success_no_key"),
      });
    } catch (err: any) {
      toast({
        title: err?.message ?? tr("platform_llm.save_error"),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiClient.testPlatformLlmConnection();
      setTestResult({
        ok: res.ok,
        message: res.latencyMs
          ? `${res.message} (${res.latencyMs}ms)`
          : res.message,
      });
    } catch (err: any) {
      setTestResult({ ok: false, message: err?.message ?? "Error" });
    } finally {
      setTesting(false);
    }
  }

  async function discoverWorkspaces() {
    setDiscovering(true);
    setDiscoverMsg(null);
    setWorkspaces([]);
    try {
      if (!apiKey.trim()) {
        setDiscoverMsg(
          "Pega primero la API key y pulsa descubrir.",
        );
        setDiscovering(false);
        return;
      }
      // P2A-platform-llm: workspace discovery was a future feature; until
      // it lands, the "Descubrir" button simply confirms the key is in
      // place and reminds the user to enter the Workspace ID manually.
      setDiscoverMsg(
        "Endpoint de descubrimiento de workspaces aún no disponible. Introduce el Workspace ID manualmente (lo encuentras en console.anthropic.com → Settings → API Keys, columna 'Workspace').",
      );
      setWorkspaces([]);
    } catch (err: any) {
      setDiscoverMsg(err?.message ?? "Error");
    } finally {
      setDiscovering(false);
    }
  }

  if (loading) {
    return <div className="text-gray-500">Cargando…</div>;
  }

  const modelPresets = MODEL_PRESETS[provider] ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          {t("platform_llm.title")}
        </h1>
        <p className="text-gray-500 mt-1 max-w-2xl">
          {t("platform_llm.subtitle")}
        </p>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t("platform_llm.provider_label")}
            </label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
            >
              {PROVIDER_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {t(`platform_llm.provider_${p.value}`)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t("platform_llm.model_label")}
            </label>
            <input
              list={`models-${provider}`}
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              placeholder="claude-haiku-4-5"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
            />
            <datalist id={`models-${provider}`}>
              {modelPresets.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <p className="text-xs text-gray-500 mt-1">
              {t("platform_llm.model_recommended")}
            </p>
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              <Key className="inline w-4 h-4 mr-1" />
              {t("platform_llm.api_key_label")}
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
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
                  title={showKey ? "🙈" : "👁"}
                >
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {cfg?.hasKey ? (
                <>
                  {t("platform_llm.api_key_active")}{" "}
                  <code className="bg-gray-100 px-1 rounded">{cfg.apiKeyMasked}</code>
                  {cfg.updatedAt && (
                    <>
                      {" "}
                      · {tr("platform_llm.api_key_saved_at", {
                        date: new Date(cfg.updatedAt).toLocaleString(),
                      })}
                    </>
                  )}
                </>
              ) : (
                <>{t("platform_llm.api_key_no_key")}</>
              )}
            </p>
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t("platform_llm.base_url_label")}
            </label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t("platform_llm.base_url_placeholder")}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
            />
            <p className="text-xs text-gray-500 mt-1">
              {t("platform_llm.base_url_help")}
            </p>
          </div>

          {provider === "anthropic" && (
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t("platform_llm.workspace_id_label")}
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
                />
                <button
                  type="button"
                  onClick={discoverWorkspaces}
                  disabled={discovering}
                  className="bg-white border border-gray-300 text-gray-700 px-3 py-2 rounded-lg hover:bg-gray-50 disabled:opacity-50 inline-flex items-center gap-2 text-sm whitespace-nowrap"
                  title="Llamar al endpoint /v1/organizations/workspaces de Anthropic"
                >
                  <Key className="w-4 h-4" />
                  {discovering ? "Buscando…" : "Descubrir"}
                </button>
              </div>
              {discoverMsg && (
                <p
                  className={`text-xs mt-1 ${
                    workspaces.length > 1
                      ? "text-gray-700"
                      : discoverMsg?.includes("Error") ||
                        discoverMsg?.includes("error")
                      ? "text-red-700"
                      : "text-green-700"
                  }`}
                >
                  {discoverMsg}
                </p>
              )}
              {workspaces.length > 1 && (
                <div className="mt-2 border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-48 overflow-y-auto">
                  {workspaces.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => setWorkspaceId(w.id)}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center justify-between"
                    >
                      <span className="text-sm">
                        <span className="font-mono text-xs text-gray-700">
                          {w.id}
                        </span>
                        {w.name && (
                          <span className="ml-2 text-gray-500">{w.name}</span>
                        )}
                      </span>
                      {w.default && (
                        <span className="text-xs px-2 py-0.5 bg-purple-100 text-purple-700 rounded">
                          default
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              <p className="text-xs text-gray-500 mt-1">
                {t("platform_llm.workspace_id_help")}
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-between items-center pt-3 border-t border-gray-100">
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

        {testResult && (
          <div
            className={`text-sm p-3 rounded-lg flex items-start gap-2 ${
              testResult.ok
                ? "bg-green-50 text-green-800 border border-green-200"
                : "bg-red-50 text-red-800 border border-red-200"
            }`}
          >
            {testResult.ok ? (
              <Check className="w-4 h-4 mt-0.5" />
            ) : (
              <AlertCircle className="w-4 h-4 mt-0.5" />
            )}
            <span>{testResult.message}</span>
          </div>
        )}
      </div>

      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800 flex items-start gap-2">
        <AlertCircle className="w-4 h-4 mt-0.5" />
        <div>{t("platform_llm.security_notice")}</div>
      </div>

      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-sm text-gray-600">
        <h3 className="font-semibold text-gray-800 mb-2">
          {t("platform_llm.how_to_get_title")}
        </h3>
        <ul className="space-y-1 list-disc pl-5">
          <li>
            <strong>{t("platform_llm.how_to_get_anthropic")}</strong>{" "}
            <a
              className="text-purple-700 underline"
              href="https://console.anthropic.com"
              target="_blank"
              rel="noreferrer"
            >
              console.anthropic.com
            </a>{" "}
            → Settings → API Keys → Create Key. Anthropic te regala $5 al
            registrarte.
          </li>
          <li>
            <strong>{t("platform_llm.how_to_get_openai")}</strong>{" "}
            <a
              className="text-purple-700 underline"
              href="https://platform.openai.com/api-keys"
              target="_blank"
              rel="noreferrer"
            >
              platform.openai.com/api-keys
            </a>
          </li>
          <li>
            <strong>{t("platform_llm.how_to_get_google")}</strong>{" "}
            <a
              className="text-purple-700 underline"
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noreferrer"
            >
              aistudio.google.com/apikey
            </a>
          </li>
        </ul>
      </div>
    </div>
  );
}