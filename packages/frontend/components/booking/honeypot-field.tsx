"use client";

/**
 * A field no person sees or reaches (off screen, out of the tab order,
 * hidden from screen readers, no autofill): bots that fill in every input
 * fill it in, and the server drops their booking quietly (the backend's
 * isHoneypotHit). Used by the salon page and the booking widget.
 */
export function HoneypotField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div
      aria-hidden="true"
      style={{ position: "absolute", left: "-10000px", top: "auto", width: 1, height: 1, overflow: "hidden" }}
    >
      <label>
        Website
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    </div>
  );
}
