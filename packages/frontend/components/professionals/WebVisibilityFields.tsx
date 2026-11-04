"use client";

/** "Mostrar en la web": how the salon's page, widget and chat name her. */
export type WebNameDisplay = "full" | "initial" | "hidden";

/** New professionals: first name and initial, no photo (the salon needs her consent for more). */
export const NEW_PROFESSIONAL_WEB = { webNameDisplay: "initial" as WebNameDisplay, webShowPhoto: false };

/**
 * The professional's visibility on the salon's public page and widget, with
 * the notice that the salon needs her consent to show her. "No mostrar":
 * she can still be booked, as "Profesional".
 */
export function WebVisibilityFields({
  nameDisplay,
  showPhoto,
  onChange,
  disabled,
  t,
}: {
  nameDisplay: WebNameDisplay;
  showPhoto: boolean;
  onChange: (next: { webNameDisplay: WebNameDisplay; webShowPhoto: boolean }) => void;
  disabled?: boolean;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  const options: WebNameDisplay[] = ["full", "initial", "hidden"];
  return (
    <fieldset data-test="professional-web-visibility" className="space-y-3 rounded-lg border border-gray-200 p-4">
      <legend className="px-1 text-sm font-medium text-gray-900">{t("professionals.web.title")}</legend>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-4">
        {options.map((o) => (
          <label key={o} className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="radio"
              name="webNameDisplay"
              value={o}
              checked={nameDisplay === o}
              disabled={disabled}
              onChange={() => onChange({ webNameDisplay: o, webShowPhoto: o === "hidden" ? false : showPhoto })}
              className="h-4 w-4"
            />
            {t(`professionals.web.${o}`)}
          </label>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          checked={showPhoto && nameDisplay !== "hidden"}
          disabled={disabled || nameDisplay === "hidden"}
          onChange={(e) => onChange({ webNameDisplay: nameDisplay, webShowPhoto: e.target.checked })}
          className="h-4 w-4 rounded"
        />
        {t("professionals.web.photo")}
      </label>
      <p className="text-xs text-gray-500">
        {nameDisplay === "hidden" ? t("professionals.web.hiddenHint") : t("professionals.web.consent")}
      </p>
    </fieldset>
  );
}
