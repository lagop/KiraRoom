"use client";

import type { EmailSettingSource } from "@/lib/api";
import { sourceText } from "@/lib/platform-email";

/**
 * One platform setting in the console: its label, where its value comes from
 * (and the last characters of a secret), a "Quitar" link when it is set here,
 * the input and a hint.
 */
export function SettingField(props: {
  label: string;
  source: EmailSettingSource;
  current: string | null;
  hint: React.ReactNode;
  onClear?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <label className="text-sm font-medium text-gray-700">{props.label}</label>
        <span className="text-xs text-gray-500">
          {sourceText(props.source)}
          {props.current ? ` · ${props.current}` : ""}
          {props.onClear && (
            <button type="button" onClick={props.onClear} className="ml-2 underline hover:text-gray-700">
              Quitar
            </button>
          )}
        </span>
      </div>
      {props.children}
      <div className="text-xs text-gray-500 mt-1">{props.hint}</div>
    </div>
  );
}
