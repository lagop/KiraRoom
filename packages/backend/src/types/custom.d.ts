declare module "qrcode" {
  export function toBuffer(
    text: string,
    opts?: { type?: "png"; errorCorrectionLevel?: "L" | "M" | "Q" | "H"; width?: number; margin?: number; color?: { dark?: string; light?: string } }
  ): Promise<Buffer>;
  export function toString(
    text: string,
    opts?: { type?: "svg" | "utf8" | "terminal"; errorCorrectionLevel?: "L" | "M" | "Q" | "H"; width?: number }
  ): Promise<string>;
  export function toDataURL(
    text: string,
    opts?: { errorCorrectionLevel?: "L" | "M" | "Q" | "H"; width?: number }
  ): Promise<string>;
}

declare module "ics" {
  export interface EventAttributes {
    uid?: string;
    title: string;
    start: [number, number, number, number, number] | Date | number[];
    end?: [number, number, number, number, number] | Date | number[];
    description?: string;
    location?: string;
    url?: string;
    status?: string;
    busyStatus?: string;
    organizer?: { name: string; email: string };
    attendees?: Array<{ name: string; email: string; rsvp?: boolean }>;
    productId?: string;
    calName?: string;
    duration?: { hours?: number; minutes?: number };
    categories?: string[];
    alarms?: any[];
    htmlContent?: string;
    recurrenceRule?: string;
  }
  export interface ReturnObject {
    error?: Error | null;
    value?: string;
  }
  export function createEvents(events: EventAttributes[]): ReturnObject;
}

declare module "papaparse" {
  export interface ParseConfig {
    delimiter?: string;
    header?: boolean;
    skipEmptyLines?: boolean | "greedy";
    transformHeader?: (h: string, index: number) => string;
    dynamicTyping?: boolean;
    encoding?: string;
    quoteChar?: string;
    escapeChar?: string;
    preview?: number;
  }
  export interface ParseResult<T> {
    data: T[];
    errors: Array<{ code?: string; message?: string; row?: number }>;
    meta: { delimiter?: string; linebreak?: string; aborted?: boolean; truncated?: boolean; cursor?: number; fields?: string[] };
  }
  export function parse<T = any>(input: string, config?: ParseConfig): ParseResult<T>;
  export function unparse(input: any[], config?: any): string;
}

declare module "express-rate-limit" {
  import { RequestHandler } from "express";
  const rateLimit: (options?: any) => RequestHandler;
  export default rateLimit;
}