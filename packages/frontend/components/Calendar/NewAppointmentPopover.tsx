import React, { useState, useEffect, useRef, useMemo } from "react";
import { format } from "date-fns";
import { X, Search, CheckCircle, Loader2, Zap, DollarSign, Percent } from "lucide-react";
import { SlotClickData } from "./TimeSlot";
import { Professional } from "./types";
import apiClient from "../../lib/api";
import { getCurrentUser } from "../../lib/utils";

interface ClientOption {
  id: string;
  name: string;
  email?: string;
  phone?: string;
}

interface ServiceOption {
  id: string;
  name: string;
  duration: number;
  price: number;
}

interface NewAppointmentPopoverProps {
  slot: SlotClickData;
  professionals: Professional[];
  tenantId?: string;
  onClose: () => void;
  onSuccess: () => void;
}

export const NewAppointmentPopover: React.FC<NewAppointmentPopoverProps> = ({
  slot,
  professionals,
  tenantId = "default",
  onClose,
  onSuccess,
}) => {
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [clientId, setClientId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [clientSearch, setClientSearch] = useState("");
  const [showClientSuggestions, setShowClientSuggestions] = useState(false);
  const [notes, setNotes] = useState("");
  const [depositRequired, setDepositRequired] = useState(false);
  const [depositAmount, setDepositAmount] = useState(0);
  const [commissionRate, setCommissionRate] = useState(0);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const popoverRef = useRef<HTMLDivElement>(null);
  const clientSearchRef = useRef<HTMLDivElement>(null);

  const professional = professionals.find((p) => p.id === slot.professionalId);

  const filteredClients = useMemo(() => {
    if (!clientSearch) return [];
    const q = clientSearch.toLowerCase();
    return clients.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.email && c.email.toLowerCase().includes(q)) ||
        (c.phone && c.phone.includes(q))
    );
  }, [clientSearch, clients]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setFetching(true);
        const [clientsData, servicesData] = await Promise.all([
          apiClient.getClients(),
          apiClient.getServices(),
        ]);

        const mappedClients = (clientsData as any[]).map((c: any) => ({
          id: c.id,
          name: `${c.firstName} ${c.lastName}`,
          email: c.email,
          phone: c.phone,
        }));
        setClients(mappedClients);

        const rawServices = (servicesData as any).data || servicesData;
        const mappedServices = (rawServices as any[]).map((s: any) => ({
          id: s.id,
          name: s.name,
          duration: s.duration,
          price: s.price,
        }));
        setServices(mappedServices);
      } catch (err) {
        console.error("Error fetching data for popover:", err);
      } finally {
        setFetching(false);
      }
    };
    fetchData();
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  const handleClientSelect = (client: ClientOption) => {
    setClientId(client.id);
    setClientSearch(client.name);
    setShowClientSuggestions(false);
  };

  const handleSubmit = async () => {
    if (!clientId || !serviceId) return;

    setLoading(true);
    try {
      const dateStr = format(slot.date, "yyyy-MM-dd");
      const timeStr = `${slot.hour.toString().padStart(2, "0")}:${slot.minute.toString().padStart(2, "0")}`;

      const currentUser = getCurrentUser();
      const appointmentData = {
        tenantId,
        clientId,
        serviceId,
        professionalId: slot.professionalId,
        scheduledDate: dateStr,
        scheduledTime: timeStr,
        notes: notes || undefined,
        depositRequired: depositRequired,
        depositAmount: depositRequired ? depositAmount : undefined,
        commissionRate: commissionRate !== 0 ? commissionRate : undefined,
      };

      if (currentUser?.role === "staff") {
        await apiClient.createAppointmentByStaff(appointmentData);
      } else {
        await apiClient.createAppointment(appointmentData);
      }

      onSuccess();
    } catch (err) {
      console.error("Error creating appointment:", err);
    } finally {
      setLoading(false);
    }
  };

  const topOffset =
    ((slot.hour - 8) * 4 + slot.minute / 15) * 24;

  return (
    <div className="absolute inset-0 z-30 pointer-events-none">
      <div
        ref={popoverRef}
        className="absolute left-1/2 -translate-x-1/2 w-80 bg-background border border-border rounded-lg shadow-xl p-4 pointer-events-auto"
        style={{ top: topOffset + 48 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-sm">New Appointment</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {fetching ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="text-xs text-muted-foreground mb-3">
              {professional?.name} • {slot.hour.toString().padStart(2, "0")}:
              {slot.minute.toString().padStart(2, "0")}
            </div>

            <div className="space-y-3">
              <div ref={clientSearchRef}>
                <label className="block text-xs font-medium mb-1">Client</label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type="text"
                    value={clientSearch}
                    onChange={(e) => {
                      setClientSearch(e.target.value);
                      setShowClientSuggestions(true);
                      if (!e.target.value) {
                        setClientId("");
                      }
                    }}
                    onFocus={() => setShowClientSuggestions(true)}
                    className="w-full pl-8 pr-3 py-1.5 text-sm border border-border rounded-md focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-background"
                    placeholder="Search client..."
                  />
                </div>
                {showClientSuggestions && clientSearch && (
                  <div className="absolute z-40 w-72 mt-1 bg-background border border-border rounded-md shadow-lg max-h-48 overflow-y-auto">
                    {filteredClients.length === 0 ? (
                      <div className="px-3 py-2 text-muted-foreground text-xs">
                        No clients found
                      </div>
                    ) : (
                      filteredClients.map((client) => (
                        <button
                          key={client.id}
                          type="button"
                          onClick={() => handleClientSelect(client)}
                          className={`w-full px-3 py-2 text-left hover:bg-accent transition-colors text-sm ${
                            clientId === client.id ? "bg-accent" : ""
                          }`}
                        >
                          <div className="font-medium">{client.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {client.email && <span>{client.email}</span>}
                            {client.email && client.phone && <span> • </span>}
                            {client.phone && <span>{client.phone}</span>}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
                {clientId && (
                  <div className="mt-1 flex items-center text-xs text-green-600">
                    <CheckCircle className="w-3 h-3 mr-1" />
                    Client selected
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">Service</label>
                <select
                  value={serviceId}
                  onChange={(e) => setServiceId(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm border border-border rounded-md focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-background"
                >
                  <option value="">Select service...</option>
                  {services.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name} ({service.duration}min)
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleSubmit}
                  disabled={!clientId || !serviceId || loading}
                  className="flex-1 px-3 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
                >
                  {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Create
                </button>
                <button
                  onClick={onClose}
                  className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-accent transition-colors"
                >
                  Cancel
                </button>
              </div>

              {/* Notes Section */}
              <div className="border-t pt-4 mt-4">
<label className="block text-xs font-medium mb-1">
  <Search className="w-4 h-4 mr-1 text-indigo-600" />
  Notes
</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-1.5 text-sm border border-border rounded-md focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-background"
                  placeholder="Add additional notes..."
                />
              </div>

              {/* Deposit Payment Section */}
              <div className="border-t pt-4 mt-4">
                <label className="block text-xs font-medium mb-1 flex items-center">
                  <DollarSign className="w-4 h-4 mr-1 text-indigo-600" />
                  Deposit Payment
                </label>
                <div className="space-y-2">
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={depositRequired}
                      onChange={(e) => setDepositRequired(e.target.checked)}
                      className="w-3 h-3 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                    />
                    <span className="ml-2 text-xs text-gray-700">
                      Require deposit
                    </span>
                  </label>

                  {depositRequired && (
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        Deposit Amount
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={depositAmount}
                        onChange={(e) => setDepositAmount(parseFloat(e.target.value) || 0)}
                        className="w-full px-3 py-1.5 text-sm border border-border rounded-md focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-background"
                        placeholder="0.00"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Customer will pay this amount now to confirm the booking
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Commission Rate (Admin/Owner only) */}
              <div className="border-t pt-4 mt-4">
                <label className="block text-xs font-medium mb-1 flex items-center">
                  <Percent className="w-4 h-4 mr-1 text-indigo-600" />
                  Commission Rate (%)
                </label>
                <div className="space-y-2">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={commissionRate}
                    onChange={(e) => setCommissionRate(parseInt(e.target.value) || 0)}
                    className="w-full px-3 py-1.5 text-sm border border-border rounded-md focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-background"
                    placeholder="Leave empty for default rate"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Commission rate override for this appointment (admin/owner only)
                  </p>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
