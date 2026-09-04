export class AppointmentScheduler {
  private salonHours: any;
  private SETUP_TIME: number;

  constructor(
    salonHours: any = { open: "09:00", close: "20:00" },
    setupTime: number = 5,
  ) {
    this.salonHours = salonHours;
    this.SETUP_TIME = setupTime;
  }

  generateScheduleOptions(
    services: any[],
    professionalAvailability: any,
    date: Date,
    timePreference?: any,
  ): any[] | { error: string } {
    console.log("=== GENERANDO OPCIONES DE HORARIO ===");
    console.log("Servicios:", services.length);
    console.log("Profesionales:", Object.keys(professionalAvailability).length);

    // Validate input data
    if (!services || services.length === 0) {
      return { error: "No services selected" };
    }

    if (
      !professionalAvailability ||
      Object.keys(professionalAvailability).length === 0
    ) {
      return { error: "No professional availability data available" };
    }

    const allOptions: any[] = [];

    // For next_available preference, generate multiple time-based options
    if (timePreference?.type === "next_available" || !timePreference?.type) {
      // Try different starting times to give 3-4 distinct options
      const timeSlots = ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"];

      let optionsGenerated = 0;
      const maxOptions = 4;

      for (
        let i = 0;
        i < timeSlots.length && optionsGenerated < maxOptions;
        i++
      ) {
        const timeSlot = timeSlots[i];
        const option = this.generateTimeBasedStrategy(
          services,
          professionalAvailability,
          date,
          timeSlot,
          "next_available",
        );

        if (option) {
          // Generate dynamic label based on ACTUAL scheduled time, not target time
          const actualStartMinutes = this.timeToMinutes(option.startTime);
          const dynamicLabel = this.generateTimeBasedLabel(
            actualStartMinutes,
            i,
          );
          option.label = dynamicLabel;
          option.badge = this.generateTimeBasedBadge(actualStartMinutes);
          option.priority = i + 1;
          allOptions.push(option);
          optionsGenerated++;
          console.log(
            `  ✓ Generated next_available option ${i + 1}: target=${timeSlot}, actual=${option.startTime}`,
          );
        }
      }

      // If we couldn't generate enough time-based options, fall back to compact strategy
      if (allOptions.length < 2) {
        const compactOption = this.generateCompactStrategy(
          services,
          professionalAvailability,
          date,
        );
        if (compactOption) {
          compactOption.label = "Más Rápido";
          compactOption.badge = "Sin esperas";
          compactOption.priority = 1;
          allOptions.unshift(compactOption);
        }
      }
    } else if (timePreference?.type === "today_morning") {
      const morningOption = this.generateTimeBasedStrategy(
        services,
        professionalAvailability,
        date,
        "10:00",
        "today_morning",
      );
      if (morningOption) {
        morningOption.label = "Mañana";
        morningOption.badge = "Horario matutino";
        morningOption.priority = 1;
        allOptions.push(morningOption);
      }
    } else if (timePreference?.type === "today_afternoon") {
      const afternoonOption = this.generateTimeBasedStrategy(
        services,
        professionalAvailability,
        date,
        "15:00",
        "today_afternoon",
      );
      if (afternoonOption) {
        afternoonOption.label = "Tarde";
        afternoonOption.badge = "Horario vespertino";
        afternoonOption.priority = 1;
        allOptions.push(afternoonOption);
      }
    } else if (timePreference?.type === "flexible") {
      const flexibleOption = this.generateTimeBasedStrategy(
        services,
        professionalAvailability,
        date,
        "11:00",
        "flexible",
      );
      if (flexibleOption) {
        flexibleOption.label = "Flexible";
        flexibleOption.badge = "Horario conveniente";
        flexibleOption.priority = 1;
        allOptions.push(flexibleOption);
      }
    }

    // Score and rank options
    allOptions.forEach((option) => {
      option.score = this.calculateScore(option, timePreference);
    });

    allOptions.sort((a, b) => (b.score || 0) - (a.score || 0));

    // Ensure we have at least 3 options, diversify and return top 4
    let finalOptions = this.diversifyOptions(allOptions, 4);

    // Return top 4 options
    finalOptions = finalOptions.slice(0, 4);

    console.log(`\n=== OPCIONES GENERADAS: ${finalOptions.length} ===`);
    finalOptions.forEach((opt, idx) => {
      console.log(
        `${idx + 1}. ${opt.label} - ${opt.startTime} (${opt.score || 0}pts)`,
      );
    });

    return finalOptions;
  }

  generateTimeBasedStrategy(
    services: any[],
    availability: any,
    date: Date,
    targetTime: string,
    strategyType: string,
  ): any {
    const startMinutes = this.timeToMinutes(targetTime);
    const schedule = this.planServicesFromTime(
      services,
      availability,
      startMinutes,
      date,
    );

    if (!schedule) {
      console.log(`  ✗ No availability from ${targetTime}`);
      return null;
    }

    const option = this.createOption(schedule, strategyType, date);
    console.log(`  ✓ Generated: ${option.startTime} - ${option.endTime}`);

    return option;
  }

  generateCompactStrategy(
    services: any[],
    availability: any,
    date: Date,
    timePreference?: any,
  ): any {
    console.log("\n--- Estrategia Compacta ---");

    const schedule = [];
    const professionalEndTimes: any = {};

    for (const service of services) {
      const professionalId = service.professionalId;
      let earliestStart = Math.max(
        professionalEndTimes[professionalId] || this.timeToMinutes("09:00"),
        this.timeToMinutes("09:00"),
      );

      if (
        timePreference?.morningPreferred &&
        !timePreference.afternoonPreferred
      ) {
        earliestStart = Math.max(earliestStart, this.timeToMinutes("09:00"));
      } else if (
        timePreference?.afternoonPreferred &&
        !timePreference.morningPreferred
      ) {
        earliestStart = Math.max(earliestStart, this.timeToMinutes("14:00"));
      }

      const slot = this.findFirstAvailableSlot(
        professionalId,
        availability[professionalId] || [],
        earliestStart,
        service.duration,
        date,
      );

      if (!slot) {
        console.log(
          `  ✗ No slot found for ${service.name} with ${service.professionalName}`,
        );
        return null;
      }

      schedule.push({
        serviceId: service.id,
        serviceName: service.name,
        professionalId: professionalId,
        professionalName: service.professionalName,
        startTime: slot.start,
        endTime: slot.end,
        duration: service.duration,
      });

      professionalEndTimes[professionalId] = slot.end + this.SETUP_TIME;
    }

    const option = this.createOption(schedule, "compact", date);
    console.log(`  ✓ Generated: ${option.startTime} - ${option.endTime}`);
    return option;
  }

  planServicesFromTime(
    services: any[],
    availability: any,
    startMinutes: number,
    date: Date,
  ): any[] {
    const schedule = [];
    const professionalEndTimes: any = {};

    for (const service of services) {
      const professionalId = service.professionalId;
      const earliestStart = Math.max(
        professionalEndTimes[professionalId] || startMinutes,
        startMinutes,
      );

      const slot = this.findFirstAvailableSlot(
        professionalId,
        availability[professionalId] || [],
        earliestStart,
        service.duration,
        date,
      );

      if (!slot) {
        return [];
      }

      schedule.push({
        serviceId: service.id,
        serviceName: service.name,
        professionalId: professionalId,
        professionalName: service.professionalName,
        startTime: slot.start,
        endTime: slot.end,
        duration: service.duration,
      });

      professionalEndTimes[professionalId] = slot.end + this.SETUP_TIME;
    }

    return schedule;
  }

  findFirstAvailableSlot(
    professionalId: string,
    slots: any[],
    fromMinutes: number,
    durationNeeded: number,
    date: Date,
  ): any {
    if (!slots || slots.length === 0) {
      return null;
    }

    for (const slot of slots) {
      const slotStart = this.timeToMinutes(slot.start);
      const slotEnd = this.timeToMinutes(slot.end);

      if (slotStart >= fromMinutes) {
        const availableDuration = slotEnd - slotStart;

        if (availableDuration >= durationNeeded) {
          return {
            start: slotStart,
            end: slotStart + durationNeeded,
          };
        }
      }
    }

    return null;
  }

  createOption(schedule: any[], strategyType: string, date?: Date): any {
    if (!schedule || schedule.length === 0) return null;

    const startTime = Math.min(...schedule.map((s) => s.startTime));
    const endTime = Math.max(...schedule.map((s) => s.endTime));
    const totalDuration = endTime - startTime;

    let waitTime = 0;
    const sortedSchedule = [...schedule].sort(
      (a, b) => a.startTime - b.startTime,
    );

    for (let i = 0; i < sortedSchedule.length - 1; i++) {
      const currentEnd = sortedSchedule[i].endTime;
      const nextStart = sortedSchedule[i + 1].startTime;
      const gap = nextStart - currentEnd;
      if (gap > this.SETUP_TIME) {
        waitTime += gap - this.SETUP_TIME;
      }
    }

    return {
      id: `${strategyType}_${Date.now()}`,
      strategy: strategyType,
      label: strategyType,
      startTime: this.minutesToTime(startTime),
      endTime: this.minutesToTime(endTime),
      date: date?.toISOString().split("T")[0],
      totalDuration: totalDuration,
      waitTime: waitTime,
      schedule: schedule.map((item) => ({
        serviceId: item.serviceId,
        serviceName: item.serviceName,
        professionalId: item.professionalId,
        professionalName: item.professionalName,
        startTime: this.minutesToTime(item.startTime),
        endTime: this.minutesToTime(item.endTime),
        duration: item.duration,
      })),
      highlight: false,
    };
  }

  calculateScore(option: any, timePreference?: any): number {
    let score = 0;

    // Prefer shorter total duration
    score += Math.max(0, 480 - option.totalDuration); // Max 8 hours

    // Prefer less wait time
    score += Math.max(0, 120 - option.waitTime); // Max 2 hours wait

    // Prefer options that match time preferences
    if (timePreference) {
      const startMinutes = this.timeToMinutes(option.startTime);

      if (
        timePreference.morningPreferred &&
        startMinutes < this.timeToMinutes("12:00")
      ) {
        score += 50;
      }

      if (
        timePreference.afternoonPreferred &&
        startMinutes >= this.timeToMinutes("12:00")
      ) {
        score += 50;
      }
    }

    return score;
  }

  diversifyOptions(allOptions: any[], targetCount: number): any[] {
    if (allOptions.length <= targetCount) {
      return allOptions;
    }

    const selected = [allOptions[0]]; // Always include best option

    for (
      let i = 1;
      i < allOptions.length && selected.length < targetCount;
      i++
    ) {
      const candidate = allOptions[i];
      let isDifferent = true;

      for (const existing of selected) {
        const startDiff = Math.abs(
          this.timeToMinutes(candidate.startTime) -
            this.timeToMinutes(existing.startTime),
        );

        if (startDiff < 30 && candidate.strategy === existing.strategy) {
          isDifferent = false;
          break;
        }
      }

      if (isDifferent) {
        selected.push(candidate);
      }
    }

    return selected;
  }

  minutesToTime(minutes: number): string {
    if (typeof minutes !== "number" || isNaN(minutes)) return "00:00";
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
  }

  generateTimeBasedLabel(actualStartMinutes: number, index: number): string {
    const hours = Math.floor(actualStartMinutes / 60);
    const minutes = actualStartMinutes % 60;
    const timeStr = `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;

    if (hours >= 6 && hours < 12) {
      if (hours <= 9) {
        return `${timeStr} AM (Mañana Temprano)`;
      } else if (hours <= 11) {
        return `${timeStr} AM (Mañana)`;
      }
      return `${timeStr} AM (Mediodía)`;
    } else if (hours >= 12 && hours < 17) {
      if (hours <= 14) {
        return `${timeStr} PM (Tarde)`;
      }
      return `${timeStr} PM (Tarde Tardía)`;
    } else if (hours >= 17 && hours < 20) {
      return `${timeStr} PM (Última Hora)`;
    } else {
      return `${timeStr} (Fuera de horario)`;
    }
  }

  generateTimeBasedBadge(actualStartMinutes: number): string {
    const hours = Math.floor(actualStartMinutes / 60);

    if (hours >= 6 && hours < 12) {
      if (hours <= 9) return "Más temprano";
      if (hours <= 11) return "Mañana";
      return "Mediodía";
    } else if (hours >= 12 && hours < 17) {
      if (hours <= 14) return "Después del almuerzo";
      return "Tarde";
    } else if (hours >= 17 && hours < 20) {
      return "Últimas horas";
    } else {
      return "Fuera de horario";
    }
  }

  timeToMinutes(timeStr: string): number {
    if (typeof timeStr !== "string") return 0;
    const [hours, minutes] = timeStr.split(":").map(Number);
    return (hours || 0) * 60 + (minutes || 0);
  }
}

export default AppointmentScheduler;
