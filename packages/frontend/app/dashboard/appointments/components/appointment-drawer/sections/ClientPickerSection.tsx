import React, { useRef, useState } from "react";
import { CheckCircle, Search, User } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";
import { useClickOutside } from "../hooks/useClickOutside";
import type { CatalogClient } from "../hooks/useAppointmentCatalog";

/**
 * Step 1 of the create-mode form: client autocomplete picker.
 *
 * Verbatim move from `appointment-drawer.tsx:727-792`. The dropdown
 * visibility state (`showClientSuggestions`) and the `clientSearchRef`
 * live here locally — they don't need to leak out of the section.
 */
export interface ClientPickerSectionProps {
  clients: ReadonlyArray<CatalogClient>;
  selectedClientId: string;
  onSelect: (client: CatalogClient) => void;
  /**
   * Called when the user clears the search field (types an empty
   * string). The original orchestrator wired this to also reset
   * `newAppointment.clientId` so that a manually-cleared search
   * invalidated the previous selection. The section preserves that
   * behaviour by surfacing it as a callback rather than reaching
   * into the form state.
   */
  onSearchClear?: () => void;
}

export function ClientPickerSection({
  clients,
  selectedClientId,
  onSelect,
  onSearchClear,
}: ClientPickerSectionProps) {
  const t = useTranslations();
  const [search, setSearch] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, () => setShowSuggestions(false));

  const filtered = clients.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
        <User className="w-5 h-5 mr-2 text-indigo-600" />
        {t("appointments.client")}
      </h3>
      <div className="relative" ref={ref}>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              const value = e.target.value;
              setSearch(value);
              setShowSuggestions(true);
              if (!value) {
                onSearchClear?.();
              }
            }}
            onFocus={() => setShowSuggestions(true)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
            placeholder={t("appointments.search_client_placeholder")}
          />
        </div>
        {showSuggestions && search && (
          <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-4 py-3 text-gray-500 text-sm">
                {t("appointments.no_clients_found")}
              </div>
            ) : (
              filtered.map((client) => (
                <button
                  key={client.id}
                  type="button"
                  onClick={() => {
                    onSelect(client);
                    setSearch(client.name);
                    setShowSuggestions(false);
                  }}
                  className={`w-full px-4 py-3 text-left hover:bg-indigo-50 transition-colors ${
                    selectedClientId === client.id ? "bg-indigo-50" : ""
                  }`}
                >
                  <div className="font-medium text-gray-900">{client.name}</div>
                  <div className="text-sm text-gray-500">
                    {client.email && <span>{client.email}</span>}
                    {client.email && client.phone && <span> • </span>}
                    {client.phone && <span>{client.phone}</span>}
                  </div>
                </button>
              ))
            )}
          </div>
        )}
        {selectedClientId && (
          <div className="mt-2 flex items-center text-sm text-green-600">
            <CheckCircle className="w-4 h-4 mr-1" />
            {t("appointments.client_selected")}
          </div>
        )}
      </div>
    </div>
  );
}