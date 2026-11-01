import { useEffect, useMemo, useState } from "react";
import apiClient from "../../../../../../lib/api";
import { DEFAULT_SALON_TIMEZONE } from "@kira/shared";
import { getCurrentUser } from "../../../../../../lib/utils";
import { staffOwnCatalog } from "../../appointment-drawer.utils";

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
 *
 * A professional (role `staff`) gets their own professional and the
 * services they perform, and `currentUser` carries that professional's id
 * and name: the token has neither. See staffOwnCatalog.
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
  /** The professional's panel login; present in the salon's own (staff) view. */
  userId?: string | null;
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
  id?: string;
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
  const [allServices, setServices] = useState<CatalogService[]>([]);
  const [allProfessionals, setProfessionals] = useState<CatalogProfessional[]>([]);
  const [clients, setClients] = useState<CatalogClient[]>([]);
  const [user, setCurrentUser] = useState<CatalogUser | null>(null);
  const [allowProfessionalCrossBooking, setAllowProfessionalCrossBooking] =
    useState<boolean>(false);
  // Until the salon's own zone arrives: the zone a salon starts on, not
  // UTC, which put every time an hour or two off.
  const [timezone, setTimezone] = useState<string>(DEFAULT_SALON_TIMEZONE);

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
      const servicesData = data.data || data;

      // A professional's own services are picked out below, from their
      // professional record (staffOwnCatalog). This used to fetch it from
      // /admin/professionals, which refuses staff: the list came out empty.
      // A deactivated service is off the menu: not offered for a new
      // booking or to add to one (the server refuses it for a new booking).
      // An appointment that already has it keeps showing it (ServiceCard).
      setServices(
        servicesData.filter((s: any) => s.isActive !== false).map((s: any) => ({
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
      setTimezone(tenant.timezone || DEFAULT_SALON_TIMEZONE);
    } catch (error) {
      console.error("Error fetching tenant timezone:", error);
      setTimezone(DEFAULT_SALON_TIMEZONE);
    }
  };

  // Re-fetch services when user/setting/drawer-open changes (verbatim from line 852-856)
  useEffect(() => {
    if (user && open) {
      fetchServices();
    }
  }, [user, open, allowProfessionalCrossBooking]);

  // A professional books on their own agenda. Not linked to a professional
  // of the salon: nothing to book with (the server refuses it too).
  const { currentUser, professionals, services } = useMemo(() => {
    if (user?.role !== "staff") {
      return { currentUser: user, professionals: allProfessionals, services: allServices };
    }
    const own = staffOwnCatalog(user.id, allProfessionals, allServices);
    if (!own) return { currentUser: user, professionals: [], services: [] };
    return {
      currentUser: {
        ...user,
        professionalId: own.me.id,
        firstName: own.me.firstName,
        lastName: own.me.lastName,
      },
      professionals: own.professionals,
      services: own.services,
    };
  }, [user, allProfessionals, allServices]);

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