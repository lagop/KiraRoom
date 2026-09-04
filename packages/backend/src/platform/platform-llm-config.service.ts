import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../common/prisma/prisma.service";
import { EncryptionService } from "../common/encryption/encryption.service";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { LLMProvider } from "@kira/shared";

/**
 * P2A-platform-llm: platform-wide LLM configuration.
 *
 * The Virtual Receptionist uses a single shared provider + API key for
 * every tenant. Salon owners do NOT interact with this service — the
 * only client is the saas_owner admin UI.
 *
 * The API key is encrypted at rest with the existing
 * `EncryptionService` (AES-256-GCM, KMS-backed). Plaintext keys only
 * exist in memory while we're actively calling the provider.
 *
 * If no row exists yet, the LLM service falls back to the env-var key
 * (legacy behavior). The UI lets the admin migrate to DB-managed keys.
 */

export interface PlatformLlmConfigPublic {
  provider: string;
  defaultModel: string;
  baseUrl: string | null;
  workspaceId: string | null;
  // The full key is never returned; only last-4-chars + a stable hash
  // for the UI to detect "did the key change".
  apiKeyMasked: string;
  apiKeyLastFour: string;
  apiKeyHash: string;
  hasKey: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

@Injectable()
export class PlatformLlmConfigService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlatformLlmConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * P2A-platform-llm: at boot, if a platform row exists in the DB,
   * decrypt the key and inject it (and provider-specific URLs) into
   * `process.env` so the existing LLM providers — which read
   * API keys from env in their constructors — pick them up without
   * any changes to their constructor signatures.
   *
   * This is a one-time bootstrap. Subsequent updates via the admin UI
   * take effect on the NEXT request, since `getProviderForSalon` /
   * `getModelForSalon` re-read the DB on every call and the
   * resolved provider / model are picked up by the orchestrator.
   * (Provider API key rotation requires a backend restart today;
   * that's an acceptable trade-off for v1.)
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const eff = await this.resolveEffective();
      if (!eff) {
        this.logger.log(
          "No PlatformLlmConfig row — keeping env-var LLM defaults.",
        );
        return;
      }
      switch (eff.provider) {
        case LLMProvider.ANTHROPIC:
          if (eff.apiKey) process.env.ANTHROPIC_API_KEY = eff.apiKey;
          break;
        case LLMProvider.OPENAI:
          if (eff.apiKey) process.env.OPENAI_API_KEY = eff.apiKey;
          break;
        case LLMProvider.GOOGLE:
          if (eff.apiKey) process.env.GOOGLE_API_KEY = eff.apiKey;
          break;
        case LLMProvider.MiniMax:
          if (eff.apiKey) process.env.MINIMAX_API_KEY = eff.apiKey;
          if (eff.baseUrl) process.env.MINIMAX_BASE_URL = eff.baseUrl;
          break;
      }
      // P2A-anthropic-workspace: identity-linked keys need this header.
      // Sync to env so the AnthropicProvider picks it up via the
      // existing hot-reload pattern.
      if (eff.workspaceId) {
        process.env.ANTHROPIC_WORKSPACE_ID = eff.workspaceId;
      }
      this.logger.log(
        `Platform LLM config applied: provider=${eff.provider} model=${eff.model}${eff.workspaceId ? ' (workspace)' : ''}`,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to apply platform LLM config at boot: ${(err as Error).message}`,
      );
    }
  }


  /**
   * Return the public (masked) view of the platform LLM config. Salon
   * APIs and tenant APIs should never see this object — it leaks the
   * provider name and the key fingerprint.
   */
  async getConfig(): Promise<PlatformLlmConfigPublic> {
    const row = await this.prisma.platformLlmConfig.findUnique({
      where: { id: "global" },
    });
    if (!row) {
      return {
        provider: "anthropic",
        defaultModel: "claude-haiku-4-5",
        baseUrl: null,
        workspaceId: null,
        apiKeyMasked: "",
        apiKeyLastFour: "",
        apiKeyHash: "",
        hasKey: false,
        updatedAt: null,
        updatedBy: null,
      };
    }
    return this.toPublic(row);
  }

  /**
   * Upsert the platform config. Encrypts the API key before persisting.
   * Returns the public view (no plaintext key).
   */
  async updateConfig(input: {
    provider?: string;
    apiKey?: string;
    defaultModel?: string;
    baseUrl?: string | null;
    workspaceId?: string | null;
    updatedBy?: string;
  }): Promise<PlatformLlmConfigPublic> {
    const existing = await this.prisma.platformLlmConfig.findUnique({
      where: { id: "global" },
    });

    const data: Record<string, unknown> = {};

    if (input.provider !== undefined) {
      // P2A-platform-llm: keep the provider enum in lockstep with the
      // shared LLMProvider enum, but accept any string here for forward
      // compatibility (e.g. a new provider hasn't been added yet).
      data.provider = input.provider;
    }
    if (input.defaultModel !== undefined) data.defaultModel = input.defaultModel;
    if (input.baseUrl !== undefined) data.baseUrl = input.baseUrl ?? null;
    if (input.workspaceId !== undefined) {
      // Empty string clears the field; otherwise store as-is.
      const trimmed = (input.workspaceId ?? "").trim();
      data.workspaceId = trimmed.length > 0 ? trimmed : null;
    }

    // Only overwrite the encrypted key when a non-empty value is
    // supplied. An empty string means "keep the existing key".
    if (input.apiKey && input.apiKey.trim().length > 0) {
      data.apiKeyEncrypted = this.encryption.encrypt(input.apiKey.trim());
    }
    if (input.updatedBy) data.updatedBy = input.updatedBy;

    const row = await this.prisma.platformLlmConfig.upsert({
      where: { id: "global" },
      create: {
        id: "global",
        provider: input.provider ?? "anthropic",
        defaultModel: input.defaultModel ?? "claude-haiku-4-5",
        baseUrl: input.baseUrl ?? null,
        workspaceId: input.workspaceId ?? null,
        // On first creation an apiKey MUST be provided; otherwise we
        // seed with a placeholder so the row is creatable and the admin
        // can fill it later. We only need to encrypt the empty string
        // when the row doesn't exist yet — on update we leave the key
        // alone entirely.
        apiKeyEncrypted:
          (data.apiKeyEncrypted as string | undefined) ??
          (existing ? existing.apiKeyEncrypted : this.encryption.encrypt("")),
        updatedBy: input.updatedBy ?? null,
      },
      update: data,
    });
    this.logger.log(
      `Platform LLM config updated provider=${row.provider} model=${row.defaultModel}${input.workspaceId ? ' (workspace set)' : ''}`,
    );
    return this.toPublic(row);
  }

  /**
   * Decrypt and return the API key. Internal — NEVER expose via HTTP.
   * Returns `null` if no key has been set yet.
   */
  async getDecryptedApiKey(): Promise<string | null> {
    const row = await this.prisma.platformLlmConfig.findUnique({
      where: { id: "global" },
    });
    if (!row || !row.apiKeyEncrypted) return null;
    try {
      const plain = this.encryption.decrypt(row.apiKeyEncrypted);
      return plain.length > 0 ? plain : null;
    } catch (err) {
      this.logger.warn(
        `Failed to decrypt platform LLM API key: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Resolve the runtime configuration for the LLM service. Used as a
   * drop-in replacement for env-var defaults.
   */
  async resolveEffective(): Promise<{
    provider: LLMProvider | null;
    model: string;
    baseUrl: string | undefined;
    apiKey: string | undefined;
    workspaceId: string | null;
  } | null> {
    const row = await this.prisma.platformLlmConfig.findUnique({
      where: { id: "global" },
    });
    if (!row) return null;
    const apiKey = await this.getDecryptedApiKey();
    if (!apiKey) return null;

    // Map the stored provider string to the shared enum. Falls back
    // to the env-var provider if we don't recognize the value.
    const normalized = (row.provider || "").toLowerCase();
    let provider: LLMProvider;
    switch (normalized) {
      case "anthropic":
        provider = LLMProvider.ANTHROPIC;
        break;
      case "openai":
        provider = LLMProvider.OPENAI;
        break;
      case "google":
        provider = LLMProvider.GOOGLE;
        break;
      case "MiniMax":
        provider = LLMProvider.MiniMax;
        break;
      default:
        provider = LLMProvider.ANTHROPIC;
    }

    return {
      provider,
      model: row.defaultModel,
      baseUrl: row.baseUrl ?? undefined,
      apiKey,
      workspaceId: row.workspaceId ?? null,
    };
  }

  /**
   * P2A-platform-llm: make a real API call with the stored key to
   * verify it works. The admin uses this button to confirm the key
   * is valid before saving (and before going to production). Returns
   * a short summary on success or the API error message on failure.
   */
  async testConnection(): Promise<{
    ok: boolean;
    message: string;
    model?: string;
    latencyMs?: number;
  }> {
    const config = await this.resolveEffective();
    if (!config) {
      return { ok: false, message: "No API key configured" };
    }

    const start = Date.now();
    try {
      if (config.provider === LLMProvider.ANTHROPIC) {
        const client = new Anthropic({
          apiKey: config.apiKey,
          baseURL: config.baseUrl,
        });
        const res = await client.messages.create({
          model: config.model,
          max_tokens: 32,
          messages: [{ role: "user", content: "ping" }],
        });
        const latency = Date.now() - start;
        const text = (res.content ?? [])
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join(" ")
          .trim();
        return {
          ok: true,
          message: text || `Connected (model=${res.model})`,
          model: res.model,
          latencyMs: latency,
        };
      }
      if (config.provider === LLMProvider.OPENAI) {
        const client = new OpenAI({ apiKey: config.apiKey });
        const res = await client.chat.completions.create({
          model: config.model,
          max_tokens: 32,
          messages: [{ role: "user", content: "ping" }],
        });
        const latency = Date.now() - start;
        return {
          ok: true,
          message:
            res.choices[0]?.message?.content?.slice(0, 100) ??
            `Connected (model=${res.model})`,
          model: res.model,
          latencyMs: latency,
        };
      }
      return {
        ok: false,
        message: `Test connection not implemented for provider=${config.provider}`,
      };
    } catch (err: any) {
      const message =
        err?.message ||
        err?.error?.error?.message ||
        "Unknown error contacting provider";
      return {
        ok: false,
        message: this.sanitizeProviderError(providerLabel(config.provider), message),
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Strip the API key from any error message we surface to the UI so
   * we never leak credentials through a 500 response or a log line.
   */
  private sanitizeProviderError(provider: string, message: string): string {
    const redacted = message.replace(/sk-[a-zA-Z0-9-]{10,}/g, "sk-***REDACTED***");
    return `[${provider}] ${redacted}`;
  }

  /**
   * P2A-anthropic-workspace: call Anthropic's admin API to list the
   * workspaces a given API key has access to. Used by the admin UI
   * when the user doesn't know which workspace ID to plug in (the
   * console hides it for identity-linked keys assigned to "all
   * workspaces"). The API key is sent in the request body and is
   * never persisted.
   */
  async listAnthropicWorkspaces(apiKey: string): Promise<{
    ok: boolean;
    workspaces: Array<{ id: string; name?: string; type?: string; default?: boolean }>;
    message?: string;
  }> {
    if (!apiKey || !apiKey.trim().startsWith("sk-")) {
      return {
        ok: false,
        workspaces: [],
        message: "API key missing or malformed (must start with sk-)",
      };
    }

    // Anthropic exposes two slightly different endpoints depending on
    // the org tier. We try the modern one first and fall back to the
    // legacy `list` suffix if it returns 404.
    const candidates = [
      "https://api.anthropic.com/v1/organizations/workspaces",
      "https://api.anthropic.com/v1/organizations/workspaces/list",
    ];

    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: {
            "x-api-key": apiKey.trim(),
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
        });
        if (res.status === 404) continue;
        const text = await res.text();
        if (!res.ok) {
          return {
            ok: false,
            workspaces: [],
            message: this.sanitizeProviderError(
              "anthropic",
              `Anthropic ${res.status}: ${text.slice(0, 240)}`,
            ),
          };
        }
        let body: any;
        try {
          body = JSON.parse(text);
        } catch {
          return { ok: false, workspaces: [], message: "Anthropic returned non-JSON" };
        }
        const raw = Array.isArray(body?.data)
          ? body.data
          : Array.isArray(body?.workspaces)
          ? body.workspaces
          : [];
        const workspaces = raw
          .filter((w: any) => w && typeof w.id === "string")
          .map((w: any) => ({
            id: w.id,
            name: w.name ?? w.display_name ?? w.id,
            type: w.type,
            default:
              w.default === true ||
              w.is_default === true ||
              w.id === body?.default_workspace_id ||
              raw.length === 1,
          }));
        return { ok: true, workspaces };
      } catch (err) {
        return {
          ok: false,
          workspaces: [],
          message: this.sanitizeProviderError(
            "anthropic",
            (err as Error)?.message ?? "Network error contacting Anthropic",
          ),
        };
      }
    }
    return {
      ok: false,
      workspaces: [],
      message:
        "Anthropic admin endpoints returned 404. Your API key may lack the `user:profile:read` scope required to list workspaces.",
    };
  }

  private toPublic(row: {
    provider: string;
    defaultModel: string;
    baseUrl: string | null;
    workspaceId: string | null;
    apiKeyEncrypted: string;
    updatedAt: Date;
    updatedBy: string | null;
  }): PlatformLlmConfigPublic {
    let apiKeyLastFour = "";
    let apiKeyHash = "";
    let apiKeyMasked = "";
    try {
      const plain = this.encryption.decrypt(row.apiKeyEncrypted);
      if (plain.length > 0) {
        apiKeyLastFour = plain.slice(-4);
        apiKeyHash = this.encryption.hashIp(plain).slice(0, 12);
        apiKeyMasked =
          plain.length > 8
            ? `${plain.slice(0, 4)}${"•".repeat(Math.max(plain.length - 8, 4))}${plain.slice(-4)}`
            : "•".repeat(plain.length);
      }
    } catch {
      // Decryption failed — most likely the master key rotated or
      // the ciphertext was corrupted. Surface a clear hint.
      apiKeyMasked = "[unreadable — re-enter the key]";
    }
    return {
      provider: row.provider,
      defaultModel: row.defaultModel,
      baseUrl: row.baseUrl,
      workspaceId: row.workspaceId,
      apiKeyMasked,
      apiKeyLastFour,
      apiKeyHash,
      hasKey: apiKeyLastFour.length > 0,
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
    };
  }
}

function providerLabel(p: LLMProvider): string {
  switch (p) {
    case LLMProvider.ANTHROPIC:
      return "anthropic";
    case LLMProvider.OPENAI:
      return "openai";
    case LLMProvider.GOOGLE:
      return "google";
    case LLMProvider.MiniMax:
      return "MiniMax";
    default:
      return String(p);
  }
}