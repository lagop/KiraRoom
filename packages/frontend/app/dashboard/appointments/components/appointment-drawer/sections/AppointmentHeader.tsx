import React from "react";
import {
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { useTranslations } from "@/lib/use-translation";

/**
 * Drawer title + description. Two-line copy depending on whether the
 * drawer is in create mode or view/edit mode.
 *
 * Verbatim move from `appointment-drawer.tsx:705-716`.
 */
export interface AppointmentHeaderProps {
  appointmentId: string | null;
}

export function AppointmentHeader({ appointmentId }: AppointmentHeaderProps) {
  const t = useTranslations();
  return (
    <DrawerHeader>
      <DrawerTitle>
        {!appointmentId
          ? t("appointments.new_appointment")
          : t("appointments.appointment_details")}
      </DrawerTitle>
      <DrawerDescription>
        {!appointmentId
          ? t("appointments.create_new_appointment")
          : t("appointments.view_manage_appointment")}
      </DrawerDescription>
    </DrawerHeader>
  );
}