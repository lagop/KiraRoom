// components/calendar/mock.ts
import { Appointment } from "./types";

export const appointments: Appointment[] = [
  {
    id: "1",
    professionalId: "1",
    clientName: "María González",
    serviceName: "Corte y tinte",
    start: new Date(2026, 0, 10, 9, 0).toISOString(),
    end: new Date(2026, 0, 10, 10, 30).toISOString(),
    type: "appointment",
  },
  {
    id: "2",
    professionalId: "1",
    clientName: "Laura Martínez",
    serviceName: "Peinado",
    start: new Date(2026, 0, 10, 11, 0).toISOString(),
    end: new Date(2026, 0, 10, 11, 45).toISOString(),
    type: "appointment",
  },
  {
    id: "3",
    professionalId: "2",
    clientName: "Carmen López",
    serviceName: "Mechas",
    start: new Date(2026, 0, 10, 9, 30).toISOString(),
    end: new Date(2026, 0, 10, 11, 0).toISOString(),
    type: "appointment",
  },
  {
    id: "4",
    professionalId: "2",
    clientName: undefined,
    serviceName: "Descanso",
    start: new Date(2026, 0, 10, 13, 0).toISOString(),
    end: new Date(2026, 0, 10, 14, 0).toISOString(),
    type: "lunch",
  },
  {
    id: "5",
    professionalId: "3",
    clientName: "Ana Rodríguez",
    serviceName: "Tratamiento capilar",
    start: new Date(2026, 0, 10, 10, 0).toISOString(),
    end: new Date(2026, 0, 10, 11, 15).toISOString(),
    type: "appointment",
  },
  {
    id: "6",
    professionalId: "3",
    clientName: undefined,
    serviceName: "Bloqueado",
    start: new Date(2026, 0, 10, 15, 0).toISOString(),
    end: new Date(2026, 0, 10, 16, 30).toISOString(),
    type: "blocked",
  },
];
