import { BadRequestException, ForbiddenException, Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { UserRole } from "@prisma/client";
import { LLMProvider } from "@kira/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { EncryptionService } from "../common/encryption/encryption.service";
import { AuditLogService } from "../saas/audit-log.service";
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL } from "../virtual-receptionist/providers/anthropic-models";
import { buildClient } from "../virtual-receptionist/providers/anthropic.provider";

/**
 * P2A-platform-llm: platform-wide LLM configuration.
 *
 * The Virtual Receptionist uses a single shared provider + API key for
 * every tenant. Salon owners do NOT interact with this service — the
 * only client is the saas_owner admin UI.
 *
 * The API key is encrypted at rest with the existing
 * `EncryptionService` (AES-256-GCM). Plaintext keys only exist in memory
 * while we're actively calling the provider.
 *
 * Without a key in the console, the LLM service uses the server's .env
 * (ANTHROPIC_API_KEY). A key stored here that cannot be decrypted (the
 * encryption key changed) is NOT replaced by the .env's in silence: the
 * receptionist and the copilot stop until it is typed again or removed
 * ("Quitar"), and the console says so in red.
 *
 * Changing it needs two-step sign-in on the account doing it, and every
 * change is audited (`platform.llm_config.updated`, which fields, never
 * the key), like the email and Stripe settings.
 */

/**
 * Audit 8 D9: the receptionist runs on Anthropic only. The console offers
 * no other provider, and the model is one of CLAUDE_MODELS.
 */
export const PLATFORM_LLM_PROVIDERS = ["anthropic"] as const;
export const PLATFORM_LLM_MODELS: readonly string[] = CLAUDE_MODELS.map((m) => m.id);

export function isPlatformLlmModel(model: string | null | undefined): boolean {
  return !!model && PLATFORM_LLM_MODELS.includes(model);
}

/** Where the key in use comes from. */
export type LlmKeySource = "console" | "server" | "none" | "unreadable";

export interface PlatformLlmConfigPublic {
  provider: string;
  defaultModel: string;
  workspaceId: string | null;
  // The full key is never returned; only last-4-chars + a stable hash
  // for the UI to detect "did the key change".
  apiKeyMasked: string;
  apiKeyLastFour: string;
  apiKeyHash: string;
  hasKey: boolean;
  /** The console's key: set, none, or stored but unreadable. */
  keyState: "set" | "none" | "unreadable";
  /** Whether the server's .env has ANTHROPIC_API_KEY (never its value). */
  serverKey: boolean;
  /** Which key the receptionist uses now. */
  inUse: LlmKeySource;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface PlatformLlmConfigUpdate {
  provider?: string;
  /** Empty or absent keeps the stored key. */
  apiKey?: string;
  defaultModel?: string;
  workspaceId?: string | null;
}

/** Values typed in the form, tested without saving; each falls back to the one in force. */
export interface PlatformLlmTestInput {
  provider?: string;
  apiKey?: string;
  defaultModel?: string;
  workspaceId?: string | null;
}

interface Actor {
  id: string;
  role: string;
}

/** The console's key is stored but cannot be decrypted: no silent fallback to the .env. */
export class StoredLlmKeyUnreadableError extends Error {
  constructor() {
    super("La clave de IA guardada en la consola no se puede descifrar: vuelve a escribirla o quítala en la consola.");
    this.name = "StoredLlmKeyUnreadableError";
  }
}

const TWO_FACTOR_REQUIRED =
  "Para cambiar la IA de la plataforma, activa antes la verificación en dos pasos en Seguridad.";

@Injectable()
export class PlatformLlmConfigService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlatformLlmConfigService.name);
  /** The .env's ANTHROPIC_API_KEY before the console's was copied over it at boot. */
  private readonly serverAnthropicKey: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly configService: ConfigService,
    private readonly auditLog?: AuditLogService,
  ) {
    this.serverAnthropicKey = process.env.ANTHROPIC_API_KEY;
  }

  /**
   * P2A-platform-llm: at boot, if a platform row exists in the DB,
   * decrypt the key and inject it into `process.env` so the providers that
   * read their key from the environment pick it up. Requests to Anthropic
   * take the console's key with each request anyway (LLMService), so a
   * change applies to the next message without a restart.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const eff = await this.resolveEffective();
      if (!eff) {
        this.logger.log("No platform LLM key in the console: using the server's .env.");
        return;
      }
      if (eff.apiKey) process.env.ANTHROPIC_API_KEY = eff.apiKey;
      // P2A-anthropic-workspace: identity-linked keys need this header.
      if (eff.workspaceId) {
        process.env.ANTHROPIC_WORKSPACE_ID = eff.workspaceId;
      }
      this.logger.log(
        `Platform LLM config applied: provider=${eff.provider} model=${eff.model}${eff.workspaceId ? " (workspace)" : ""}`,
      );
    } catch (err) {
      this.logger.error(`Platform LLM config not applied at boot: ${(err as Error).message}`);
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
        defaultModel: DEFAULT_CLAUDE_MODEL,
        workspaceId: null,
        apiKeyMasked: "",
        apiKeyLastFour: "",
        apiKeyHash: "",
        hasKey: false,
        keyState: "none",
        serverKey: this.hasServerKey(),
        inUse: this.hasServerKey() ? "server" : "none",
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
  async updateConfig(input: PlatformLlmConfigUpdate, actor: Actor): Promise<PlatformLlmConfigPublic> {
    const email = await this.assertTwoFactor(actor);
    // Anthropic only, with a Claude model (D9). The DTO refuses the rest
    // already; this keeps any other caller to the same closed lists.
    if (input.provider !== undefined && !(PLATFORM_LLM_PROVIDERS as readonly string[]).includes(input.provider)) {
      throw new BadRequestException("La recepcionista solo funciona con Anthropic.");
    }
    if (input.defaultModel !== undefined && !isPlatformLlmModel(input.defaultModel)) {
      throw new BadRequestException("Elige uno de los modelos de Claude de la lista.");
    }
    const existing = await this.prisma.platformLlmConfig.findUnique({
      where: { id: "global" },
    });

    const data: Record<string, unknown> = {};

    if (input.provider !== undefined) data.provider = input.provider;
    if (input.defaultModel !== undefined) data.defaultModel = input.defaultModel;
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
    data.updatedBy = email;

    const row = await this.prisma.platformLlmConfig.upsert({
      where: { id: "global" },
      create: {
        id: "global",
        provider: input.provider ?? "anthropic",
        defaultModel: input.defaultModel ?? DEFAULT_CLAUDE_MODEL,
        workspaceId: (data.workspaceId as string | null | undefined) ?? null,
        // No key yet: an encrypted empty string, i.e. "use the .env's".
        apiKeyEncrypted:
          (data.apiKeyEncrypted as string | undefined) ??
          (existing ? existing.apiKeyEncrypted : this.encryption.encrypt("")),
        updatedBy: email,
      },
      update: data,
    });
    await this.auditLog?.record("platform.llm_config.updated", {
      actorId: actor.id,
      actorRole: actor.role as UserRole,
      // Which settings changed; the provider and model are not secret, the key is never logged.
      metadata: {
        set: Object.keys(data).filter((k) => k !== "updatedBy").map((k) => (k === "apiKeyEncrypted" ? "apiKey" : k)),
        provider: row.provider,
        model: row.defaultModel,
      },
    });
    this.logger.log(
      `Platform LLM config updated by ${actor.id}: provider=${row.provider} model=${row.defaultModel}${data.apiKeyEncrypted ? " (new key)" : ""}`,
    );
    return this.toPublic(row);
  }

  /**
   * "Quitar": removes the console's key, so the server's .env applies
   * again (ANTHROPIC_API_KEY). Provider, model and workspace are kept for
   * the next key.
   */
  async clearApiKey(actor: Actor): Promise<PlatformLlmConfigPublic> {
    const email = await this.assertTwoFactor(actor);
    const existing = await this.prisma.platformLlmConfig.findUnique({ where: { id: "global" } });
    if (!existing) return this.getConfig();
    const row = await this.prisma.platformLlmConfig.update({
      where: { id: "global" },
      data: { apiKeyEncrypted: this.encryption.encrypt(""), updatedBy: email },
    });
    // The console's key was copied over the .env's at boot: put it back.
    if (this.serverAnthropicKey) process.env.ANTHROPIC_API_KEY = this.serverAnthropicKey;
    else delete process.env.ANTHROPIC_API_KEY;
    await this.auditLog?.record("platform.llm_config.updated", {
      actorId: actor.id,
      actorRole: actor.role as UserRole,
      metadata: { cleared: ["apiKey"], provider: row.provider, model: row.defaultModel },
    });
    this.logger.log(`Platform LLM key removed by ${actor.id}: the server's .env applies`);
    return this.toPublic(row);
  }

  /**
   * Decrypt and return the API key. Internal — NEVER expose via HTTP.
   * Returns `null` if no key has been set; throws
   * StoredLlmKeyUnreadableError if one is stored but cannot be decrypted.
   */
  async getDecryptedApiKey(): Promise<string | null> {
    const row = await this.prisma.platformLlmConfig.findUnique({
      where: { id: "global" },
    });
    if (!row || !row.apiKeyEncrypted) return null;
    return this.openKey(row.apiKeyEncrypted);
  }

  /**
   * Resolve the runtime configuration for the LLM service. Null when the
   * console has no key (the .env applies). Throws StoredLlmKeyUnreadableError
   * when its key cannot be decrypted: the .env's must not be used instead.
   */
  async resolveEffective(): Promise<{
    provider: LLMProvider | null;
    model: string;
    apiKey: string | undefined;
    workspaceId: string | null;
  } | null> {
    const row = await this.prisma.platformLlmConfig.findUnique({
      where: { id: "global" },
    });
    if (!row) return null;
    const apiKey = row.apiKeyEncrypted ? this.openKey(row.apiKeyEncrypted) : null;
    if (!apiKey) return null;

    // Anthropic only (D9). A row saved for another provider (MiniMax,
    // removed in November 2026, or OpenAI / Google, removed from the
    // console) runs on Anthropic with the default Claude model: its model
    // id would be wrong for Anthropic, and its key must be replaced.
    const anthropic = (row.provider || "").toLowerCase() === "anthropic";
    return {
      provider: LLMProvider.ANTHROPIC,
      model: anthropic && isPlatformLlmModel(row.defaultModel) ? row.defaultModel : DEFAULT_CLAUDE_MODEL,
      apiKey,
      workspaceId: row.workspaceId ?? null,
    };
  }

  /**
   * A real call to the provider, so the admin sees a key or a model is
   * wrong before every salon does. With typed values it tests those
   * without saving them (each one falls back to the one in force). The
   * Anthropic call is built exactly like the receptionist's (same client,
   * same workspace header).
   */
  async testConnection(typed: PlatformLlmTestInput = {}): Promise<{
    ok: boolean;
    message: string;
    model?: string;
    latencyMs?: number;
  }> {
    let config: { provider: LLMProvider | null; model: string; apiKey: string | undefined; workspaceId: string | null } | null;
    try {
      config = await this.resolveEffective();
    } catch (err) {
      if (!(err instanceof StoredLlmKeyUnreadableError) || !typed.apiKey?.trim()) {
        return { ok: false, message: (err as Error).message };
      }
      config = null;
    }
    const typedKey = typed.apiKey?.trim();
    if (typed.provider && !(PLATFORM_LLM_PROVIDERS as readonly string[]).includes(typed.provider)) {
      return { ok: false, message: "La recepcionista solo funciona con Anthropic." };
    }
    const apiKey = typedKey || config?.apiKey || this.serverAnthropicKey;
    const model = typed.defaultModel?.trim() || config?.model || DEFAULT_CLAUDE_MODEL;
    if (!isPlatformLlmModel(model)) {
      return { ok: false, message: "Elige uno de los modelos de Claude de la lista." };
    }
    const workspaceId = typed.workspaceId !== undefined ? typed.workspaceId?.trim() || null : config?.workspaceId ?? null;
    if (!apiKey) {
      return { ok: false, message: "No hay API key: ni escrita aquí, ni guardada en la consola, ni en el servidor (.env)." };
    }
    const unsaved = typedKey ? " (con la clave escrita, aún sin guardar)" : "";

    const start = Date.now();
    try {
      const client = buildClient(apiKey, workspaceId);
      const res = await client.messages.create({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      });
      return {
        ok: true,
        message: `Conectado con el modelo ${res.model}${unsaved}.`,
        model: res.model,
        latencyMs: Date.now() - start,
      };
    } catch (err: any) {
      const message =
        err?.message ||
        err?.error?.error?.message ||
        "Error desconocido al contactar con el proveedor";
      return {
        ok: false,
        message: this.sanitizeProviderError("anthropic", message),
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Strip the API key from any error message we surface to the UI so
   * we never leak credentials through a 500 response or a log line.
   */
  private sanitizeProviderError(provider: string, message: string): string {
    const redacted = message.replace(/sk-[a-zA-Z0-9-_]{10,}/g, "sk-***");
    return `[${provider}] ${redacted}`;
  }

  /**
   * P2A-anthropic-workspace: call Anthropic's admin API to list the
   * workspaces a given API key has access to. Used by the admin UI
   * ("Descubrir") when the user doesn't know which workspace ID to plug
   * in. The API key is sent in the request body and is never persisted.
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
        message: "Falta la API key o no es válida: empieza por «sk-».",
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
            message: this.sanitizeProviderError("anthropic", `Anthropic ${res.status}: ${text.slice(0, 240)}`),
          };
        }
        let body: any;
        try {
          body = JSON.parse(text);
        } catch {
          return { ok: false, workspaces: [], message: "Anthropic ha respondido algo que no es JSON." };
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
            (err as Error)?.message ?? "Error de red al contactar con Anthropic",
          ),
        };
      }
    }
    return {
      ok: false,
      workspaces: [],
      message:
        "Anthropic no deja listar los workspaces con esta clave (404). Escribe el Workspace ID a mano: está en console.anthropic.com → Settings → API Keys, columna «Workspace».",
    };
  }

  private async assertTwoFactor(actor: Actor): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: { twoFactorEnabled: true, email: true },
    });
    if (!user?.twoFactorEnabled) throw new ForbiddenException(TWO_FACTOR_REQUIRED);
    return user.email ?? null;
  }

  /** The stored key in clear; null when empty; throws when it cannot be decrypted. */
  private openKey(packed: string): string | null {
    let plain: string;
    try {
      plain = this.encryption.decrypt(packed);
    } catch (err) {
      this.logger.error(
        `Platform LLM API key cannot be decrypted; the receptionist is stopped until it is re-entered or removed in the console: ${(err as Error).message}`,
      );
      throw new StoredLlmKeyUnreadableError();
    }
    return plain.length > 0 ? plain : null;
  }

  private hasServerKey(): boolean {
    return !!this.serverAnthropicKey?.trim();
  }

  private toPublic(row: {
    provider: string;
    defaultModel: string;
    workspaceId: string | null;
    apiKeyEncrypted: string;
    updatedAt: Date;
    updatedBy: string | null;
  }): PlatformLlmConfigPublic {
    let apiKeyLastFour = "";
    let apiKeyHash = "";
    let apiKeyMasked = "";
    let keyState: PlatformLlmConfigPublic["keyState"] = "none";
    try {
      const plain = this.encryption.decrypt(row.apiKeyEncrypted);
      if (plain.length > 0) {
        keyState = "set";
        apiKeyLastFour = plain.slice(-4);
        apiKeyHash = this.encryption.hashIp(plain).slice(0, 12);
        apiKeyMasked =
          plain.length > 8
            ? `${plain.slice(0, 4)}${"•".repeat(Math.max(plain.length - 8, 4))}${plain.slice(-4)}`
            : "•".repeat(plain.length);
      }
    } catch {
      // The encryption key changed or the ciphertext is corrupt.
      keyState = "unreadable";
    }
    const serverKey = this.hasServerKey();
    return {
      provider: row.provider,
      defaultModel: row.defaultModel,
      workspaceId: row.workspaceId,
      apiKeyMasked,
      apiKeyLastFour,
      apiKeyHash,
      hasKey: keyState === "set",
      keyState,
      serverKey,
      inUse: keyState === "set" ? "console" : keyState === "unreadable" ? "unreadable" : serverKey ? "server" : "none",
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
    };
  }
}
