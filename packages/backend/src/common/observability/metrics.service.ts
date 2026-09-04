import { Injectable, Logger } from '@nestjs/common';

/**
 * Labeled counter with a name + key/value labels. Concurrency-safe
 * (Node JS is single-threaded so a plain Map.set() is enough). Lives
 * per process — Prometheus scrapes the /internal/metrics endpoint
 * to get the current snapshot.
 */
class LabeledCounter {
  private readonly values = new Map<string, number>();
  constructor(public readonly name: string, public readonly help: string) {}

  inc(labels: Record<string, string> = {}, by = 1): void {
    const key = this.keyOf(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  snapshot(): Array<{ labels: Record<string, string>; value: number }> {
    return Array.from(this.values.entries()).map(([k, v]) => ({
      labels: this.parseKey(k),
      value: v,
    }));
  }

  /** Reset -- exposed for tests / hot reload. */
  reset(): void {
    this.values.clear();
  }

  private keyOf(labels: Record<string, string>): string {
    return Object.keys(labels)
      .sort()
      .map((k) => `${k}=${labels[k]}`)
      .join('|');
  }

  private parseKey(key: string): Record<string, string> {
    if (key === '') return {};
    const out: Record<string, string> = {};
    for (const part of key.split('|')) {
      const [k, v] = part.split('=');
      out[k] = v;
    }
    return out;
  }
}

/**
 * Process-local metric registry. Counter writes from anywhere; the
 * `MetricsController` reads via `render()` to produce Prometheus text
 * exposition.
 *
 * P2A-receptionist-v2 — we use plain counters (no `prom-client`
 * dependency) because the surface is tiny. When a tenant moves to
 * thousands of metrics (Phase N), swap the in-process map for a
 * `prom-client` Registry — the call sites won't change.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly counters = new Map<string, LabeledCounter>();

  /**
   * Get-or-create a counter by name. The `help` is only used on first
   * registration; subsequent calls are idempotent.
   */
  counter(name: string, help: string): LabeledCounter {
    let c = this.counters.get(name);
    if (!c) {
      c = new LabeledCounter(name, help);
      this.counters.set(name, c);
      this.logger.log(`Registered counter "${name}" — ${help}`);
    }
    return c;
  }

  /**
   * Render the registry as Prometheus text exposition. Format:
   *   # HELP <name> <help>
   *   # TYPE <name> counter
   *   <name>{label="value"} <count>
   */
  render(): string {
    const out: string[] = [];
    for (const c of this.counters.values()) {
      out.push(`# HELP ${c.name} ${c.help}`);
      out.push(`# TYPE ${c.name} counter`);
      for (const snap of c.snapshot()) {
        const labels = Object.entries(snap.labels)
          .map(([k, v]) => `${k}="${esc(v)}"`)
          .join(',');
        out.push(`${c.name}{${labels}} ${snap.value}`);
      }
    }
    return out.join('\n');
  }

  /** Reset all counters — used by tests, never by production. */
  reset(): void {
    for (const c of this.counters.values()) {
      c.reset();
    }
  }
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Shared counter handles used across the v2 plan. The names are
 * stable so dashboards can pin them.
 */
export const COUNTERS = {
  AI_CALLS: 'vrm_ai_calls_total', // status = 'success' | 'cap_exceeded' | 'error'
  AI_FAIRUSE_CAP_HIT: 'vrm_ai_fairuse_cap_hit_total', // plan = esencial | pro | empresa
  FAQ_CACHE_HIT: 'vrm_faq_cache_hit_total', // (no labels)
  FAQ_CACHE_MISS: 'vrm_faq_cache_miss_total',
  ADDON_PROVISIONED: 'vrm_addon_provisioned_total', // source = 'stripe' | 'manual'; key = add_on_key
  ADDON_CANCELLED: 'vrm_addon_cancelled_total', // key = add_on_key
  MESSAGE_BUNDLE_CONSUMED: 'vrm_message_bundle_consumed_total', // channel = 'whatsapp' | 'sms'; result = 'ok' | 'no_credits'
  // H-4: channel-labeled counters for the multichannel Virtual
  // Receptionist. `channel` ∈ web | whatsapp | facebook | instagram |
  // telegram. Used by ChannelRegistry.send() and by the public
  // webhook handlers to break down outbound / inbound volume per
  // channel in Grafana / Prometheus.
  CHANNEL_INBOUND: 'vrm_channel_inbound_total', // channel + tenant_id (hashed for cardinality)
  CHANNEL_OUTBOUND: 'vrm_channel_outbound_total', // channel + result = 'ok' | 'skipped' | 'error'
  CHANNEL_GATE_BLOCKED: 'vrm_channel_gate_blocked_total', // channel + reason = 'no_feature' | 'lookup_error'
} as const;
