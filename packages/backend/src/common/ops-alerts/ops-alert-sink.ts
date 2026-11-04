import { Logger } from "@nestjs/common";
import * as Sentry from "@sentry/node";
import type { OpsAlertKind } from "./ops-alert.service";

/**
 * Where scheduled-job failures go, without each scheduler injecting a
 * service: OpsAlertService registers itself here when the app starts. In
 * unit tests nothing is registered and a failure is only logged.
 */
type Sink = (kind: OpsAlertKind, title: string, detail: string) => Promise<unknown>;

let sink: Sink | null = null;

export function setOpsAlertSink(next: Sink | null): void {
  sink = next;
}

const logger = new Logger("ScheduledJob");

/**
 * Report a scheduled job that failed: the log, GlitchTip (when a DSN is
 * set) and an email to the platform owner (at most one an hour). Never
 * throws.
 */
export async function reportJobFailure(job: string, err: unknown): Promise<void> {
  const error = err instanceof Error ? err : new Error(String(err));
  logger.error(`Scheduled job ${job} failed: ${error.message}`, error.stack);
  try {
    Sentry.captureException(error, { tags: { job } });
  } catch {
    /* reporting must not break the job runner */
  }
  if (!sink) return;
  try {
    await sink("job_failed", job, `${error.message}\n\n${(error.stack ?? "").split("\n").slice(0, 8).join("\n")}`);
  } catch {
    /* the sink logs its own failures */
  }
}

/**
 * Wraps a @Cron / @Interval method: if it throws, the failure is reported
 * (reportJobFailure) instead of only reaching @nestjs/schedule's log line.
 * Put it under @Cron; it copies existing metadata to the wrapper either way.
 *
 *   @Cron(CronExpression.EVERY_HOUR)
 *   @MonitoredJob("billing.expireTrials")
 *   async expireTrials() { ... }
 */
export function MonitoredJob(job: string): MethodDecorator {
  return (_target, _key, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => unknown;
    const wrapped = async function (this: unknown, ...args: unknown[]) {
      try {
        return await original.apply(this, args);
      } catch (err) {
        await reportJobFailure(job, err);
        return undefined;
      }
    };
    for (const key of Reflect.getMetadataKeys(original)) {
      Reflect.defineMetadata(key, Reflect.getMetadata(key, original), wrapped);
    }
    Object.defineProperty(wrapped, "name", { value: original.name });
    descriptor.value = wrapped;
    return descriptor;
  };
}
