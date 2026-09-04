import { useEffect, useState } from "react";
import apiClient from "../../../../../../lib/api";
import { getCurrentUser } from "../../../../../../lib/utils";

/**
 * Loads the appointment-creation catalog (services, professionals,
 * clients, tenant timezone, current user) when the drawer mounts.
 *
 * Verbatim move of:
 *   - `loadUserAndSettings`  (was appointment-drawer.tsx:817-849)
 *   - `fetchServices`        (was appointment-drawer.tsx:1034-1076)
 *   - `fetchProfessionals`   (was appointment-drawer.tsx:1078-1099)
 *   - `fetchClients`         (was appointment-drawer.tsx:1101-1114)
 *   - `fetchTenantTimezone`  (was appointment-drawer.tsx:1116-1124)
 *   - the mount-time `useEffect`s that trigger them
 *
 * The hook exposes setters for everything the drawer still mutates
 * (e.g. `setTimezone` is irrelevant to the catalog but used by the
 * date-picker downstream).
 */

export interface CatalogService {
  id: string;
  name: string;
  price?: number;
  duration?: number;
}

export interface CatalogProfessional {
  id: string;
  tenantId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  specialties: string[];
  profileImage?: string;
  services?: {
    serviceId: string;
    service: {
      id: string;
      name: string;
      category: string;
    };
  }[];
}

export interface CatalogClient {
  id: string;
  name: string;
  email?: string;
  phone?: string;
}

export interface CatalogUser {
  role?: string;
  professionalId?: string;
  firstName?: string;
  lastName?: string;
  // Other fields from getCurrentUser() are not consumed by the drawer.
  [key: string]: unknown;
}

// Allow reading arbitrary string fields off CatalogUser (e.g.
// `currentUser.firstName`) without TS complaining. The runtime shape
// comes from `getCurrentUser()` in `@/lib/utils`; this widening just
// keeps the catalog interface honest about which fields the drawer
// reads.
export type CatalogUserLike = CatalogUser & {
  firstName?: string;
  lastName?: string;
};

export interface UseAppointmentCatalogResult {
  services: CatalogService[];
  professionals: CatalogProfessional[];
  clients: CatalogClient[];
  currentUser: CatalogUser | null;
  allowProfessionalCrossBooking: boolean;
  timezone: string;
  refreshServices: () => Promise<void>;
  refreshProfessionals: () => Promise<void>;
  refreshClients: () => Promise<void>;
  refreshTenantTimezone: () => Promise<void>;
  refreshAll: () => Promise<void>;
}

export function useAppointmentCatalog(
  open: boolean,
): UseAppointmentCatalogResult {
  const [services, setServices] = useState<CatalogService[]>([]);
  const [professionals, setProfessionals] = useState<CatalogProfessional[]>([]);
  const [clients, setClients] = useState<CatalogClient[]>([]);
  const [currentUser, setCurrentUser] = useState<CatalogUser | null>(null);
  const [allowProfessionalCrossBooking, setAllowProfessionalCrossBooking] =
    useState<boolean>(false);
  const [timezone, setTimezone] = useState<string>("UTC");

  // Mount-time: load user + tenant settings
  useEffect(() => {
    const loadUserAndSettings = async () => {
      try {
        const user = getCurrentUser();
        setCurrentUser(user);

        // Load professional cross-booking setting (only for owners/admins)
        if (user?.role === "owner" || user?.role === "admin") {
          try {
            const settings =
              await apiClient.getProfessionalCrossBookingSetting();
            setAllowProfessionalCrossBooking(
              settings.allowProfessionalCrossBooking,
            );
          } catch (error) {
            console.error(
              "Error loading professional cross-booking settings:",
              error,
            );
            // Default to false if API fails
            setAllowProfessionalCrossBooking(false);
          }
        } else {
          // Staff users always have cross-booking disabled by default
          setAllowProfessionalCrossBooking(false);
        }
      } catch (error) {
        console.error("Error loading user:", error);
        setAllowProfessionalCrossBooking(false);
      }
    };

    loadUserAndSettings();
  }, []);

  const fetchServices = async () => {
    try {
      const data = (await apiClient.getServices()) as any;
      let servicesData = data.data || data;

      // Filter services based on user role and tenant settings
      if (currentUser?.role === "staff" && currentUser.professionalId) {
        // For staff users, check tenant settings
        if (!allowProfessionalCrossBooking) {
          // If cross-booking is NOT allowed, show only their assigned services
          try {
            const professionalData = await apiClient.getProfessional(
              currentUser.professionalId,
            );
            const assignedServiceIds =
              professionalData.services?.map(
                (ps: any) => ps.serviceId,
              ) || [];

            // Filter services to only include those assigned to this professional
            servicesData = servicesData.filter((service: any) =>
              assignedServiceIds.includes(service.id),
            );
          } catch (error) {
            console.error("Error fetching professional services:", error);
            // If we can't fetch professional services, show no services
            servicesData = [];
          }
        }
        // If cross-booking IS allowed, staff users see all services (no filtering)
      }
      // Owners and admins always see all services regardless of settings

      setServices(
        servicesData.map((s: any) => ({
          id: s.id,
          name: s.name,
          price: s.price,
          duration: s.duration,
        })),
      );
    } catch (error) {
      console.error("Error fetching services:", error);
    }
  };

  const fetchProfessionals = async () => {
    try {
      // Get tenant ID from token to scope professionals to current tenant
      let tenantId = "default-tenant";
      const token =
        typeof window !== "undefined"
          ? localStorage.getItem("kira_auth_token")
          : null;
      if (token) {
        try {
          const payload = JSON.parse(atob(token.split(".")[1]));
          tenantId = payload.tenantId || "default-tenant";
        } catch (e) {
          console.error("Error parsing token:", e);
        }
      }
      const data = (await apiClient.getProfessionalsPublic(tenantId)) as any;
      setProfessionals(data);
    } catch (error) {
      console.error("Error fetching professionals:", error);
    }
  };

  const fetchClients = async () => {
    try {
      const data = (await apiClient.getClients()) as any;
      const clientsData = data.map((client: any) => ({
        id: client.id,
        name: `${client.firstName} ${client.lastName}`,
        email: client.email,
        phone: client.phone,
      }));
      setClients(clientsData);
    } catch (error) {
      console.error("Error fetching clients:", error);
    }
  };

  const fetchTenantTimezone = async () => {
    try {
      const tenant = await apiClient.getTenant();
      setTimezone(tenant.timezone || "UTC");
    } catch (error) {
      console.error("Error fetching tenant timezone:", error);
      setTimezone("UTC");
    }
  };

  // Re-fetch services when user/setting/drawer-open changes (verbatim from line 852-856)
  useEffect(() => {
    if (currentUser && open) {
      fetchServices();
    }
  }, [currentUser, open, allowProfessionalCrossBooking]);

  return {
    services,
    professionals,
    clients,
    currentUser,
    allowProfessionalCrossBooking,
    timezone,
    refreshServices: fetchServices,
    refreshProfessionals: fetchProfessionals,
    refreshClients: fetchClients,
    refreshTenantTimezone: fetchTenantTimezone,
    refreshAll: async () => {
      await Promise.all([
        fetchProfessionals(),
        fetchClients(),
        fetchTenantTimezone(),
      ]);
    },
  };
}