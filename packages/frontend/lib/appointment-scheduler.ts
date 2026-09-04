export class AppointmentScheduler {
  private salonHours: any;
  private SETUP_TIME: number;
  private debugMode: boolean = false; // Debug flag for logging

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
    if (!this.validateAvailabilityFormat(professionalAvailability)) {
      return { error: "Invalid availability data format" };
    }

    if (!services.every(s => s.duration && s.professionalId)) {
      return { error: "Invalid service data" };
    }

    if (!services || services.length === 0) {
      return { error: "No services selected" };
    }

    if (
      !professionalAvailability ||
      Object.keys(professionalAvailability).length === 0
    ) {
      return { error: "No professional availability data available" };
    }

    // Normalize availability data
    professionalAvailability = this.normalizeAvailability(professionalAvailability, date);

    let allOptions: any[] = [];

    // For next_available preference, find the next 4 available slots across multiple days
    if (timePreference?.type === "next_available" || !timePreference?.type) {
      const nextAvailableOptions = this.findNextAvailableSlots(
        services,
        professionalAvailability,
        date,
        4, // Find exactly 4 slots
      );

      allOptions.push(...nextAvailableOptions);

      console.log(
        `  ✓ Found ${nextAvailableOptions.length} next available slots`,
      );
    } else if (timePreference?.type === "today_morning") {
      const morningOptions = this.findMorningSlots(
        services,
        professionalAvailability,
        date,
        4, // Find up to 4 morning slots
      );
      allOptions.push(...morningOptions);

      console.log(`  ✓ Found ${morningOptions.length} morning slots`);
    } else if (timePreference?.type === "today_afternoon") {
      const afternoonOptions = this.findAfternoonSlots(
        services,
        professionalAvailability,
        date,
        4, // Find up to 4 afternoon slots
      );
      allOptions.push(...afternoonOptions);

      console.log(`  ✓ Found ${afternoonOptions.length} afternoon slots`);
    } else if (timePreference?.type === "flexible") {
      // Generate up to 4 flexible slots. Honour the
      // `morningPreferred` / `afternoonPreferred` sub-checkboxes if the
      // user set them; otherwise span the whole working day.
      //
      // Bug fix: previous version had only ONE candidate for
      // `afternoonPreferred=true` (16:00) and three for
      // `morningPreferred=true` clustered at 10:00 / 10:45 / 11:30,
      // which on late-morning sessions left the user with a single
      // suggestion. We now span the window generously; the past-time
      // filter below still removes today-candidates before now+setup.
      const morningWanted = timePreference?.morningPreferred === true;
      const afternoonWanted = timePreference?.afternoonPreferred === true;
      const bothWanted = morningWanted && afternoonWanted;
      const noneWanted = !morningWanted && !afternoonWanted;

      const MORNING_TIMES = [
        "10:00",
        "10:45",
        "11:30",
        "12:15",
        "13:00",
      ];
      const AFTERNOON_TIMES = ["14:00", "15:00", "16:00", "17:00", "18:00"];

      const targets: { time: string; label: string; priority: number }[] = [];
      const addWindow = (times: string[], label: string) => {
        for (const t of times) {
          targets.push({ time: t, label, priority: targets.length + 1 });
        }
      };

      if (bothWanted) {
        // Interleave morning and afternoon so the user sees variety
        // regardless of order.
        for (let i = 0; i < Math.max(MORNING_TIMES.length, AFTERNOON_TIMES.length); i++) {
          if (i < MORNING_TIMES.length)
            addWindow([MORNING_TIMES[i]], "Mañana");
          if (i < AFTERNOON_TIMES.length)
            addWindow([AFTERNOON_TIMES[i]], "Tarde");
        }
      } else {
        if (morningWanted || noneWanted) addWindow(MORNING_TIMES, "Mañana");
        if (afternoonWanted || noneWanted) addWindow(AFTERNOON_TIMES, "Tarde");
      }

      const now = new Date();
      const isToday = date.toDateString() === now.toDateString();
      const minMinutesToday = isToday
        ? now.getHours() * 60 + now.getMinutes() + this.SETUP_TIME
        : 0;
      // Honour the salon's working hours so a 09:00–14:00 salon
      // doesn't surface 17:00 candidates.
      const openMinutes = this.parseHhmmToMinutes(
        this.salonHours?.open ?? "09:00",
      );
      const closeMinutes = this.parseHhmmToMinutes(
        this.salonHours?.close ?? "20:00",
      );
      const minSlot = Number.isFinite(openMinutes) ? openMinutes : 9 * 60;
      const maxSlot = Number.isFinite(closeMinutes) ? closeMinutes : 20 * 60;

      const seen = new Set<string>();
      for (const target of targets) {
        if (allOptions.length >= 4) break;
        const targetMin = this.timeToMinutes(target.time);
        // Drop candidates already in the past.
        if (targetMin < minMinutesToday) continue;
        // Drop candidates outside the salon's working hours.
        if (targetMin < minSlot || targetMin > maxSlot - 30) continue;

        const option = this.generateTimeBasedStrategy(
          services,
          professionalAvailability,
          date,
          target.time,
          "flexible",
          false,
        );
        if (!option) continue;
        const key = `${option.startTime}-${option.date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        option.label = `${option.startTime} (${target.label})`;
        option.badge = "Horario conveniente";
        option.priority = target.priority;
        allOptions.push(option);
      }
    } else if (
      timePreference?.type === "specific" &&
      timePreference.specificDate &&
      timePreference.specificTimePeriod
    ) {
      // Handle specific date with time period selection
      const targetDate = new Date(timePreference.specificDate);
      const specificOptions = this.findSpecificTimePeriodSlots(
        services,
        professionalAvailability,
        targetDate,
        timePreference.specificTimePeriod,
        4, // Find 4 slots
      );
      allOptions.push(...specificOptions);

      console.log(
        `  ✓ Found ${specificOptions.length} specific time period slots`,
      );
    }

    // Filter out options whose START is already in the past (with a
    // small setup-time buffer). Using startTime (not endTime) ensures
    // a 30-min slot starting 5 minutes ago is rejected.
    const nowMs = Date.now();
    allOptions = allOptions.filter((option) => {
      const optionStartMs = new Date(`${option.date}T${option.startTime}`).getTime();
      return optionStartMs > nowMs + this.SETUP_TIME * 60 * 1000;
    });

    // Score and rank options
    allOptions.forEach((option) => {
      option.score = this.calculateScore(option, timePreference, professionalAvailability);
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
    exactTimeOnly: boolean = false,
  ): any {
    try {
      const startMinutes = this.timeToMinutes(targetTime);
      const schedule = this.planServicesFromTime(
        services,
        availability,
        startMinutes,
        date,
        exactTimeOnly,
      );

      if (!schedule) {
        this.logDebug(`No availability from ${targetTime}`);
        return null;
      }

      const option = this.createOption(schedule, strategyType, date);
      if (!option) {
        this.logDebug(`Failed to create option from schedule`);
        return null;
      }

      this.logDebug(`Generated: ${option.startTime} - ${option.endTime}`);
      return option;
    } catch (error) {
      console.error('Error generating time-based strategy:', error);
      return null; // Continue with next slot instead of failing everything
    }
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
    const dateString = date.toISOString().split("T")[0];

    // Helper to get slots for this specific date only
    const getDaySlots = (profId: string) => {
      const allSlots = availability[profId] || [];
      return allSlots.filter((slot: any) => (slot.date || dateString) === dateString);
    };

    // Separate parallel and sequential services
    const parallelServices = services.filter(s => s.isParallel);
    const sequentialServices = services.filter(s => !s.isParallel);

    // Minimum-start cutoff (today → now; future days → 0). Declared
    // here so both the parallel branch (line ~213) and the sequential
    // branch (line ~260) can read it.
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const effectiveMin = isToday ? (now.getHours() * 60 + now.getMinutes()) : 0;

    // Handle parallel services first - they all start at the same time
    if (parallelServices.length > 0) {
      for (const service of parallelServices) {
        const professionalId = service.professionalId;
        let earliestStart = Math.max(this.timeToMinutes("09:00"), effectiveMin);

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

        // For parallel services, must start exactly at earliestStart (exactTimeOnly)
        const slot = this.findFirstAvailableSlot(
          professionalId,
          getDaySlots(professionalId),
          earliestStart,
          service.duration,
          date,
          true, // exactTimeOnly - parallel services must start at the same time
        );

        if (!slot) {
          console.log(
            `  ✗ No slot found for parallel ${service.name} with ${service.professionalName}`,
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

        // For parallel services, update professional end times to prevent conflicts
        professionalEndTimes[professionalId] = slot.end + this.SETUP_TIME;
      }
    }

    // Handle sequential services - they start after the previous service in the sequence (regardless of professional)
    let latestSequentialEnd = Math.max(this.timeToMinutes("09:00"), effectiveMin);

    if (
      timePreference?.morningPreferred &&
      !timePreference.afternoonPreferred
    ) {
      latestSequentialEnd = Math.max(latestSequentialEnd, this.timeToMinutes("09:00"));
    } else if (
      timePreference?.afternoonPreferred &&
      !timePreference.morningPreferred
    ) {
      latestSequentialEnd = Math.max(latestSequentialEnd, this.timeToMinutes("14:00"));
    }

    for (const service of sequentialServices) {
      const professionalId = service.professionalId;
      const earliestStart = Math.max(
        professionalEndTimes[professionalId] || latestSequentialEnd,
        latestSequentialEnd,
      );

      const slot = this.findFirstAvailableSlot(
        professionalId,
        getDaySlots(professionalId),
        earliestStart,
        service.duration,
        date,
      );

      if (!slot) {
        console.log(
          `  ✗ No slot found for sequential ${service.name} with ${service.professionalName}`,
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

      // Update both the professional-specific end time and the overall sequential end time
      professionalEndTimes[professionalId] = slot.end + this.SETUP_TIME;
      latestSequentialEnd = slot.end + this.SETUP_TIME;
    }

    const option = this.createOption(schedule, "compact", date);
    if (!option) {
      console.log(`  ✗ Failed to create compact option from schedule`);
      return null;
    }

    console.log(`  ✓ Generated: ${option.startTime} - ${option.endTime}`);
    return option;
  }

  planServicesFromTime(
    services: any[],
    availability: any,
    startMinutes: number,
    date: Date,
    exactTimeOnly: boolean = false,
  ): any[] {
    const schedule = [];
    const professionalEndTimes: any = {};
    const dateString = date.toISOString().split("T")[0];

    // Separate parallel and sequential services
    const parallelServices = services.filter(s => s.isParallel);
    const sequentialServices = services.filter(s => !s.isParallel);

    // Helper to get slots for this specific date only
    const getDaySlots = (profId: string) => {
      const allSlots = availability[profId] || [];
      return allSlots.filter((slot: any) => (slot.date || dateString) === dateString);
    };

    // Handle parallel services first - they all start at the same time
    // Use exactTimeOnly to ensure ALL parallel services start at the SAME time
    if (parallelServices.length > 0) {
      const parallelStartMinutes = startMinutes;
      for (const service of parallelServices) {
        const professionalId = service.professionalId;

        // For parallel services, must start exactly at parallelStartMinutes
        // Use exactTimeOnly=true to prevent flexible offset
        const slot = this.findFirstAvailableSlot(
          professionalId,
          getDaySlots(professionalId),
          parallelStartMinutes,
          service.duration,
          date,
          true, // exactTimeOnly - must start at exactly this time
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

        // For parallel services, update professional end times to prevent conflicts
        professionalEndTimes[professionalId] = slot.end + this.SETUP_TIME;
      }
    }

    // Handle sequential services - they start after the previous service in the sequence (regardless of professional)
    let latestSequentialEnd = startMinutes;

    for (const service of sequentialServices) {
      const professionalId = service.professionalId;
      const earliestStart = Math.max(
        professionalEndTimes[professionalId] || latestSequentialEnd,
        latestSequentialEnd,
      );

      const slot = this.findFirstAvailableSlot(
        professionalId,
        getDaySlots(professionalId),
        earliestStart,
        service.duration,
        date,
        exactTimeOnly,
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

      // Update both the professional-specific end time and the overall sequential end time
      professionalEndTimes[professionalId] = slot.end + this.SETUP_TIME;
      latestSequentialEnd = slot.end + this.SETUP_TIME;
    }

    return schedule;
  }

  findFirstAvailableSlot(
    professionalId: string,
    slots: any[],
    fromMinutes: number,
    durationNeeded: number,
    _date: Date,
    exactTimeOnly: boolean = false,
  ): any {
    if (!slots || slots.length === 0) {
      return null;
    }

    // Sort by start time
    const sortedSlots = [...slots].sort(
      (a, b) => this.timeToMinutes(a.start) - this.timeToMinutes(b.start),
    );

    for (let i = 0; i < sortedSlots.length; i++) {
      const slot = sortedSlots[i];
      const slotStart = this.timeToMinutes(slot.start);
      const slotEnd = this.timeToMinutes(slot.end);

      if (exactTimeOnly) {
        // Must start exactly at `fromMinutes` and fit inside the slot
        if (
          slotStart <= fromMinutes &&
          fromMinutes + durationNeeded <= slotEnd
        ) {
          return {
            start: fromMinutes,
            end: fromMinutes + durationNeeded,
          };
        }
      } else {
        // Flexible mode: choose earliest feasible start inside this block
        // that is >= fromMinutes and still fits the service duration
        const candidateStart = Math.max(fromMinutes, slotStart);

        if (candidateStart + durationNeeded <= slotEnd) {
          return {
            start: candidateStart,
            end: candidateStart + durationNeeded,
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
      id: `${strategyType}_${startTime}_${endTime}_${date?.toISOString().split("T")[0] || ""}_${schedule.map((s: any) => s.professionalId).join("_")}`,
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

  calculateScore(option: any, timePreference?: any, availability?: any): number {
    let score = 0;

    const startMinutes = this.timeToMinutes(option.startTime);

    // For next_available, strongly prioritize earliest time first
    if (timePreference?.type === "next_available" || !timePreference?.type) {
      // Earlier start time gets much higher score (primary sort criterion)
      // 1440 = max minutes in a day, so earlier times always score higher
      score += 1440 - startMinutes;

      // Secondary: prefer earlier dates
      if (option.date) {
        const optionDate = new Date(option.date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const daysDiff = Math.floor((optionDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        score -= daysDiff * 100; // Penalize each day into the future
      }
    }

    // Prefer shorter total duration
    score += Math.max(0, 480 - option.totalDuration); // Max 8 hours

    // Prefer less wait time
    score += Math.max(0, 120 - option.waitTime); // Max 2 hours wait

    // Service complexity: penalize more services or longer total duration
    score -= option.schedule.length * 5; // Penalty for number of services
    score -= Math.max(0, option.totalDuration - 120) / 10; // Additional penalty for very long appointments

    // Professional workload balancing: prefer professionals with more available time (less busy)
    const profLoads: Record<string, number> = {};
    if (availability) {
      option.schedule.forEach((item: any) => {
        const profId = item.professionalId;
        if (!profLoads[profId]) {
          profLoads[profId] = 0;
          if (availability[profId]) {
            availability[profId].forEach((slot: any) => {
              const duration = this.timeToMinutes(slot.end) - this.timeToMinutes(slot.start);
              profLoads[profId] += duration;
            });
          }
        }
      });
      // Bonus for average availability per professional involved
      const totalLoad = Object.values(profLoads).reduce((sum: number, load: number) => sum + load, 0);
      const avgLoad = totalLoad / Object.keys(profLoads).length;
      score += avgLoad / 10; // Higher score for more available professionals
    }

    // Prefer options that match time preferences
    if (timePreference) {
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
        // Same date and similar time (within 30 min) = duplicate
        const sameDate = candidate.date === existing.date;
        const startDiff = Math.abs(
          this.timeToMinutes(candidate.startTime) -
            this.timeToMinutes(existing.startTime),
        );

        if (sameDate && startDiff < 30) {
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

  /**
   * Find the next N available slots across multiple days in chronological order
   */
  findNextAvailableSlots(
    services: any[],
    availability: any,
    startDate: Date,
    numSlots: number = 4,
  ): any[] {
    const availableSlots: any[] = [];
    // Search a bit further out so we always reach `numSlots` even when
    // early days are full of conflicting bookings.
    const maxDaysToSearch = 10;

    console.log(
      `Searching for next ${numSlots} available slots starting from ${startDate.toDateString()}`,
    );

    // Search through consecutive days
    for (
      let dayOffset = 0;
      dayOffset < maxDaysToSearch && availableSlots.length < numSlots;
      dayOffset++
    ) {
      const searchDate = new Date(startDate);
      searchDate.setDate(startDate.getDate() + dayOffset);

      const dateString = searchDate.toISOString().split("T")[0];
      console.log(`  Searching day ${dayOffset + 1}: ${dateString}`);

      // Generate dynamic time slots from actual availability patterns
      let timeSlots: string[] = [];
      const totalDuration = services.reduce((sum, s) => sum + s.duration, 0);
      const now = new Date();
      const isToday = searchDate.toDateString() === now.toDateString();
      // Add SETUP_TIME so we never return a slot that is already in
      // progress. Without the buffer the user gets "Hoy 11:00"
      // suggestions at 11:14 with 5 minutes ago.
      const effectiveMinTime = isToday
        ? now.getHours() * 60 + now.getMinutes() + this.SETUP_TIME
        : 0;

      // Collect all required professional IDs for these services
      const requiredProfIds = [...new Set(services.map(s => s.professionalId))];

      // For parallel services, we need the INTERSECTION of all professionals' availability
      // because all parallel services must start at the same time.
      // For sequential-only services, we can use the union.
      const parallelServices = services.filter(s => s.isParallel);
      const hasParallel = parallelServices.length > 0;

      if (hasParallel) {
        // Get the intersection of availability across all parallel service professionals
        const parallelProfIds = [...new Set(parallelServices.map(s => s.professionalId))];
        let commonTimes: number[] = [];

        parallelProfIds.forEach((profId, index) => {
          const profSlots = availability[profId] || [];
          const filteredSlots = profSlots.filter((s: any) => s.date === dateString);
          const profTimes = new Set<number>();

          filteredSlots.forEach((slot: any) => {
            const slotStartMin = this.timeToMinutes(slot.start);
            const slotEndMin = this.timeToMinutes(slot.end);
            const availableStart = Math.max(slotStartMin, effectiveMinTime);
            const roundedStart = Math.ceil(availableStart / 15) * 15;

            if (slotEndMin - roundedStart >= 15) {
              for (let start = roundedStart; start <= slotEndMin - 15; start += 15) {
                profTimes.add(start);
              }
            }
          });

          if (index === 0) {
            commonTimes = [...profTimes];
          } else {
            // Keep only times that exist in both previous intersection and current professional
            commonTimes = commonTimes.filter(t => profTimes.has(t));
          }
        });

        timeSlots = commonTimes
          .sort((a, b) => a - b)
          .map(t => this.minutesToTime(t));
      } else {
        // Sequential-only: use union of all professionals' availability
        const addedTimes = new Set<string>();
        requiredProfIds.forEach(profId => {
          const profSlots = availability[profId] || [];
          const filteredSlots = profSlots.filter((s: any) => s.date === dateString);

          filteredSlots.forEach((slot: any) => {
            const slotStartMin = this.timeToMinutes(slot.start);
            const slotEndMin = this.timeToMinutes(slot.end);
            const availableStart = Math.max(slotStartMin, effectiveMinTime);
            const roundedStart = Math.ceil(availableStart / 15) * 15;

            if (slotEndMin - roundedStart >= 15) {
              for (let start = roundedStart; start <= slotEndMin - 15; start += 15) {
                const timeStr = this.minutesToTime(start);
                if (!addedTimes.has(timeStr)) {
                  addedTimes.add(timeStr);
                  timeSlots.push(timeStr);
                }
              }
            }
          });
        });

        timeSlots.sort((a, b) => this.timeToMinutes(a) - this.timeToMinutes(b));
      }

      // Wider cap so we don't artificially truncate days where many
      // short availability blocks (after the setup filter) yield few
      // useful candidates.
      timeSlots = timeSlots.slice(0, 60);

      if (timeSlots.length === 0) {
        console.log(`  No availability found among ${requiredProfIds.length} professionals on ${dateString}`);
      }

      // Use two sets: one for input time-slot collisions (no point
      // running the strategy twice on the same start time), and one
      // for output (start, date) so the user's first 4 distinct
      // suggestions are kept instead of being collapsed because two
      // input candidates happened to schedule to the same slot.
      const seenInputs = new Set<string>();
      const seenResults = new Set<string>();

      for (const timeSlot of timeSlots) {
        if (availableSlots.length >= numSlots) break;

        const inputKey = `${timeSlot}-${dateString}`;
        if (seenInputs.has(inputKey)) {
          console.log(`    ⚠ Skipping duplicate time slot: ${timeSlot}`);
          continue;
        }
        seenInputs.add(inputKey);

        // Always use flexible time matching for next available to find more options
        const useExactTime = this.shouldUseExactTime(services, "next_available");

        const option = this.generateTimeBasedStrategy(
          services,
          availability,
          searchDate,
          timeSlot,
          "next_available",
          useExactTime, // always flexible
        );

        if (option) {
          // Only collapse suggestions that are truly identical (same
          // start AND same date). Distinct days are kept distinct.
          const resultKey = `${option.startTime}-${option.date}`;
          if (seenResults.has(resultKey)) {
            console.log(
              `    ⚠ Skipping duplicate slot: ${option.startTime} on ${option.date}`,
            );
            continue;
          }
          seenResults.add(resultKey);

          console.log(
            `    ✓ Found valid slot: ${option.startTime} on ${option.date}`,
          );

          // Generate dynamic label based on actual scheduled date/time
          const actualStartMinutes = this.timeToMinutes(option.startTime);
          const dayName = this.getDayName(searchDate);
          const timeLabel = option.startTime;

          if (dayOffset === 0) {
            option.label = `Hoy ${timeLabel} (${this.generateTimeBasedBadge(actualStartMinutes)})`;
          } else if (dayOffset === 1) {
            option.label = `Mañana ${timeLabel} (${this.generateTimeBasedBadge(actualStartMinutes)})`;
          } else {
            option.label = `${dayName} ${timeLabel} (${this.generateTimeBasedBadge(actualStartMinutes)})`;
          }

          option.badge = this.generateTimeBasedBadge(actualStartMinutes);
          option.priority = availableSlots.length + 1;

          availableSlots.push(option);
          console.log(
            `    ✓ Found unique slot: ${option.label} (${availableSlots.length}/${numSlots})`,
          );
        } else {
          console.log(
            `    ✗ No availability at ${timeSlot} on ${searchDate.toDateString()}`,
          );
        }
      }
    }

    // If we couldn't find enough slots, try compact strategy as fallback
    if (availableSlots.length < numSlots) {
      console.log(
        `Only found ${availableSlots.length} slots, trying compact strategy as fallback`,
      );

      // Try compact strategy for the next few days
      for (
        let dayOffset = 0;
        dayOffset < 3 && availableSlots.length < numSlots;
        dayOffset++
      ) {
        const searchDate = new Date(startDate);
        searchDate.setDate(startDate.getDate() + dayOffset);

        const compactOption = this.generateCompactStrategy(
          services,
          availability,
          searchDate,
        );

        if (compactOption) {
          const dayName = this.getDayName(searchDate);
          const timeLabel = compactOption.startTime;

          if (dayOffset === 0) {
            compactOption.label = `Hoy ${timeLabel} (Rápido)`;
          } else if (dayOffset === 1) {
            compactOption.label = `Mañana ${timeLabel} (Rápido)`;
          } else {
            compactOption.label = `${dayName} ${timeLabel} (Rápido)`;
          }

          compactOption.badge = "Sin esperas";
          compactOption.priority = availableSlots.length + 1;

          availableSlots.push(compactOption);
          console.log(`    ✓ Added compact fallback: ${compactOption.label}`);
        }
      }
    }

    // Final deduplication to ensure no duplicates in the result
    const uniqueSlots = [];
    const seen = new Set();

    for (const slot of availableSlots) {
      const key = `${slot.startTime}-${slot.date}-${slot.label}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueSlots.push(slot);
      }
    }

    console.log(
      `Returning ${uniqueSlots.length} unique slots out of ${availableSlots.length} found`,
    );
    return uniqueSlots.slice(0, numSlots);
  }

  /**
   * Find morning slots for today_morning preference.
   *
   * When the requested date is today, candidate times already in the
   * past (with a setup-time buffer) are skipped so the user never sees
   * "9:00 in the morning" at 10:03 AM.
   */
  findMorningSlots(
    services: any[],
    availability: any,
    date: Date,
    numSlots: number = 4,
  ): any[] {
    const morningSlots: any[] = [];
    // Capped at 14:00 — past 14:00 we cross the lunch boundary and the
    // afternoon branch should take over. Previously hardcoded to
    // 09:00–11:45, which on late-morning sessions (e.g. 11:14) left
    // only one or two future candidates and produced a single
    // suggestion.
    const openMinutes = this.parseHhmmToMinutes(
      this.salonHours?.open ?? "09:00",
    );
    const morningEnd = Math.min(
      this.parseHhmmToMinutes(this.salonHours?.close ?? "20:00"),
      14 * 60,
    );
    const morningStart = Number.isFinite(openMinutes)
      ? Math.max(openMinutes, 9 * 60)
      : 9 * 60;

    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const minMinutesToday = isToday
      ? now.getHours() * 60 + now.getMinutes() + this.SETUP_TIME
      : 0;

    const morningTimes = this.generateRangeSlots(
      morningStart,
      morningEnd,
      minMinutesToday,
    );

    console.log(`Searching for morning slots on ${date.toDateString()}`);

    for (const timeSlot of morningTimes) {
      if (morningSlots.length >= numSlots) break;

      // Use centralized logic for exact time matching
      const useExactTime = this.shouldUseExactTime(services, "morning");

      const option = this.generateTimeBasedStrategy(
        services,
        availability,
        date,
        timeSlot,
        "today_morning",
        useExactTime, // always flexible
      );

      if (option) {
        // Check for duplicates
        const isDuplicate = morningSlots.some(
          (existing) =>
            existing.startTime === option.startTime &&
            existing.date === option.date,
        );

        if (!isDuplicate) {
          const actualStartMinutes = this.timeToMinutes(option.startTime);
          const timeLabel = option.startTime;

          option.label = `${timeLabel} (Mañana)`;
          option.badge = this.generateTimeBasedBadge(actualStartMinutes);
          option.priority = morningSlots.length + 1;

          morningSlots.push(option);
          console.log(`    ✓ Found morning slot: ${option.label}`);
        }
      } else {
        console.log(`    ✗ No availability at ${timeSlot}`);
      }
    }

    return morningSlots.slice(0, numSlots);
  }

  /**
   * Find afternoon slots for today_afternoon preference.
   * Span from 14:00 up to the salon's configured closing time so a
   * salon open until 20:00 actually surfaces 18:00 / 19:00 candidates.
   * Past-time guard matches `findMorningSlots`.
   */
  findAfternoonSlots(
    services: any[],
    availability: any,
    date: Date,
    numSlots: number = 4,
  ): any[] {
    const afternoonSlots: any[] = [];
    const openMinutes = this.parseHhmmToMinutes(
      this.salonHours?.open ?? "09:00",
    );
    const closeMinutes = this.parseHhmmToMinutes(
      this.salonHours?.close ?? "20:00",
    );
    const afternoonStart = Number.isFinite(openMinutes)
      ? Math.max(openMinutes, 14 * 60)
      : 14 * 60;
    const afternoonEnd = Number.isFinite(closeMinutes)
      ? closeMinutes
      : 20 * 60;

    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const minMinutesToday = isToday
      ? now.getHours() * 60 + now.getMinutes() + this.SETUP_TIME
      : 0;

    const afternoonTimes = this.generateRangeSlots(
      afternoonStart,
      afternoonEnd,
      minMinutesToday,
    );

    console.log(`Searching for afternoon slots on ${date.toDateString()}`);

    for (const timeSlot of afternoonTimes) {
      if (afternoonSlots.length >= numSlots) break;
      if (this.timeToMinutes(timeSlot) < minMinutesToday) continue;

      // Use centralized logic for exact time matching
      const useExactTime = this.shouldUseExactTime(services, "afternoon");

      const option = this.generateTimeBasedStrategy(
        services,
        availability,
        date,
        timeSlot,
        "today_afternoon",
        useExactTime, // always flexible
      );

      if (option) {
        // Check for duplicates
        const isDuplicate = afternoonSlots.some(
          (existing) =>
            existing.startTime === option.startTime &&
            existing.date === option.date,
        );

        if (!isDuplicate) {
          const actualStartMinutes = this.timeToMinutes(option.startTime);
          const timeLabel = option.startTime;

          option.label = `${timeLabel} (Tarde)`;
          option.badge = this.generateTimeBasedBadge(actualStartMinutes);
          option.priority = afternoonSlots.length + 1;

          afternoonSlots.push(option);
          console.log(`    ✓ Found afternoon slot: ${option.label}`);
        }
      } else {
        console.log(`    ✗ No availability at ${timeSlot}`);
      }
    }

    return afternoonSlots.slice(0, numSlots);
  }

  /**
   * Find slots for specific time period selection (morning/evening/specific hour)
   */
  findSpecificTimePeriodSlots(
    services: any[],
    availability: any,
    date: Date,
    timePeriod: string,
    numSlots: number = 4,
  ): any[] {
    const specificSlots: any[] = [];
    const maxDaysToSearch = 7; // Search up to a week ahead
    const now = new Date();
    const searchStartDate = new Date(date); // Start from the selected date
    let selectedTimesForSpecific: any[] = [];

    console.log(
      `Searching for ${timePeriod} slots starting from ${searchStartDate.toDateString()}`,
    );

    // Search through consecutive days starting from the selected date
    for (
      let dayOffset = 0;
      dayOffset < maxDaysToSearch && specificSlots.length < numSlots;
      dayOffset++
    ) {
      const currentSearchDate = new Date(searchStartDate);
      currentSearchDate.setDate(searchStartDate.getDate() + dayOffset);

      const isToday = currentSearchDate.toDateString() === now.toDateString();
      const currentMinutes = this.timeToMinutes(
        `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`,
      );

      console.log(
        `  Searching day ${dayOffset + 1}: ${currentSearchDate.toDateString()}${isToday ? " (today)" : ""}`,
      );

      let timeSlots: string[] = [];

      if (timePeriod === "morning") {
        // Morning: 9:00 to midday. Capped by the salon's configured
        // openingHours so a salon starting at 10:00 doesn't show 09:00.
        const morningEnd = Math.min(
          this.parseHhmmToMinutes(this.salonHours?.close ?? "20:00"),
          14 * 60,
        );
        const morningStart = Math.max(
          this.parseHhmmToMinutes(this.salonHours?.open ?? "09:00"),
          9 * 60,
        );
        timeSlots = this.generateRangeSlots(
          morningStart,
          morningEnd,
          isToday && dayOffset === 0 ? currentMinutes : 0,
        );
      } else if (timePeriod === "evening") {
        // Evening: from 14:00 to the salon's configured close (defaults
        // to 20:00). Previously hardcoded to 16:00–19:00 which silently
        // excluded late-evening slots for salons closing at 20h+.
        const eveningStart = Math.max(
          this.parseHhmmToMinutes(this.salonHours?.open ?? "09:00"),
          14 * 60,
        );
        const eveningEnd = this.parseHhmmToMinutes(
          this.salonHours?.close ?? "20:00",
        );
        timeSlots = this.generateRangeSlots(
          eveningStart,
          eveningEnd,
          isToday && dayOffset === 0 ? currentMinutes : 0,
        );
      } else {
        // Specific hour - generate slots around target time for this day
        const targetMinutes = this.timeToMinutes(timePeriod);
        const currentMinTime = isToday && dayOffset === 0 ? currentMinutes : 0;
        timeSlots = this.generateTimeSlotsAroundTarget(targetMinutes, currentMinTime);
      }

      // Search through the time slots for this day
      for (const timeSlot of timeSlots) {
        if (specificSlots.length >= numSlots) break;

        // Use centralized logic for exact time matching
        const useExactTime = this.shouldUseExactTime(services, "specific");

        const option = this.generateTimeBasedStrategy(
          services,
          availability,
          currentSearchDate,
          timeSlot,
          "specific",
          useExactTime, // exactTimeOnly - flexible for long services
        );

        if (option) {
          // Check for duplicates
          const isDuplicate = specificSlots.some(
            (existing) =>
              existing.startTime === option.startTime &&
              existing.date === option.date,
          );

          if (!isDuplicate) {
            const actualStartMinutes = this.timeToMinutes(option.startTime);
            const dayName = this.getDayName(currentSearchDate);
            const timeLabel = option.startTime;

            // Create appropriate label based on time period and day
            if (dayOffset === 0) {
              // Same day as selected
              if (timePeriod === "morning") {
                option.label = `Hoy ${timeLabel} (Mañana)`;
              } else if (timePeriod === "evening") {
                option.label = `Hoy ${timeLabel} (Tarde)`;
              } else {
                option.label = `Hoy ${timeLabel} (Específico)`;
              }
            } else if (dayOffset === 1) {
              // Tomorrow
              if (timePeriod === "morning") {
                option.label = `Mañana ${timeLabel} (Mañana)`;
              } else if (timePeriod === "evening") {
                option.label = `Mañana ${timeLabel} (Tarde)`;
              } else {
                option.label = `Mañana ${timeLabel} (Específico)`;
              }
            } else {
              // Future days
              if (timePeriod === "morning") {
                option.label = `${dayName} ${timeLabel} (Mañana)`;
              } else if (timePeriod === "evening") {
                option.label = `${dayName} ${timeLabel} (Tarde)`;
              } else {
                option.label = `${dayName} ${timeLabel} (Específico)`;
              }
            }

            option.badge = this.generateTimeBasedBadge(actualStartMinutes);
            option.priority = specificSlots.length + 1;

            specificSlots.push(option);
            console.log(`    ✓ Found specific slot: ${option.label}`);
          }
        } else {
          console.log(
            `    ✗ No availability at ${timeSlot} on ${currentSearchDate.toDateString()}`,
          );
        }
      }
    }

    // If we couldn't find enough slots, try compact strategy as fallback across days
    if (specificSlots.length < numSlots) {
      console.log(
        `Only found ${specificSlots.length} specific slots, trying compact strategy as fallback`,
      );

      // Try compact strategy for the next few days starting from selected date
      for (
        let dayOffset = 0;
        dayOffset < 3 && specificSlots.length < numSlots;
        dayOffset++
      ) {
        const fallbackDate = new Date(searchStartDate);
        fallbackDate.setDate(searchStartDate.getDate() + dayOffset);

        const compactOption = this.generateCompactStrategy(
          services,
          availability,
          fallbackDate,
        );

        if (compactOption) {
          // Check for duplicates before adding fallback option
          const isDuplicate = specificSlots.some(
            (existing) =>
              existing.startTime === compactOption.startTime &&
              existing.date === compactOption.date &&
              existing.label === compactOption.label, // Also check label
          );

          if (!isDuplicate) {
            const dayName = this.getDayName(fallbackDate);
            const timeLabel = compactOption.startTime;

            if (dayOffset === 0) {
              compactOption.label = `Hoy ${timeLabel} (Alternativa)`;
            } else if (dayOffset === 1) {
              compactOption.label = `Mañana ${timeLabel} (Alternativa)`;
            } else {
              compactOption.label = `${dayName} ${timeLabel} (Alternativa)`;
            }

            compactOption.badge = "Sin esperas";
            compactOption.priority = specificSlots.length + 1;

            specificSlots.push(compactOption);
            console.log(`    ✓ Added compact fallback: ${compactOption.label}`);
          } else {
            console.log(
              `    ⚠ Skipped duplicate compact fallback: ${compactOption.startTime} on ${compactOption.date}`,
            );
          }
        }
      }
    }

    return specificSlots.slice(0, numSlots);
  }

  /**
   * Generate time slots in order of proximity to a target time
   */
  generateTimeSlotsAroundTarget(
    targetMinutes: number,
    minTimeMinutes: number = 0,
  ): string[] {
    const timeSlots: string[] = [];
    const addedTimes = new Set<number>();

    // Hours are derived from the salon's configured openingHours (see
    // constructor) so a salon closing at 20:00 surfaces 18:30 / 19:00
    // suggestions instead of stopping at the previous hardcoded 19:00.
    const openMinutes = this.parseHhmmToMinutes(
      this.salonHours?.open ?? "09:00",
    );
    const closeMinutes = this.parseHhmmToMinutes(
      this.salonHours?.close ?? "20:00",
    );

    // Generate slots within +/- 2h of the target (every 15 min),
    // prioritised by distance from target. Exact match first, then
    // the nearest alternatives on either side, expanding outward.
    const intervals = [0, 15, 30, 45, 60, 75, 90, 105, 120]; // minutes from target

    for (const interval of intervals) {
      const tries: number[] = [];
      if (interval === 0) {
        tries.push(targetMinutes);
      } else {
        // After-target first, then before — keeps the user's chosen
        // hour (or the closest later slot) above earlier alternatives,
        // so 18:30 picks 18:30 / 18:45 / 18:15 / 19:00 … not 17:00.
        tries.push(targetMinutes + interval, targetMinutes - interval);
      }

      for (const t of tries) {
        if (
          t >= minTimeMinutes &&
          t >= openMinutes &&
          t <= closeMinutes - 30 // last start must leave room for service
        ) {
          if (!addedTimes.has(t)) {
            addedTimes.add(t);
            timeSlots.push(this.minutesToTime(t));
          }
        }
      }

      if (timeSlots.length >= 12) break;
    }

    console.log(
      `    Generated ${timeSlots.length} time slots around ${this.minutesToTime(targetMinutes)}: ${timeSlots.slice(0, 6).join(", ")}${timeSlots.length > 6 ? "..." : ""}`,
    );
    return timeSlots;
  }

  private parseHhmmToMinutes(value: string): number {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
    if (!m) return Number.NaN;
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (hh < 0 || hh > 24 || mm < 0 || mm >= 60) return Number.NaN;
    return hh * 60 + mm;
  }

  /**
   * Generate HH:MM strings every 15 minutes from `startMinutes` up to
   * (and including) `endMinutes - 30` so the last start always has
   * room for the smallest service. Items earlier than `minMinutes`
   * are dropped (used to skip past times on today's date).
   */
  private generateRangeSlots(
    startMinutes: number,
    endMinutes: number,
    minMinutes: number = 0,
  ): string[] {
    const slots: string[] = [];
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes)) return slots;
    const lastStart = endMinutes - 30;
    for (let m = startMinutes; m <= lastStart; m += 15) {
      if (m < minMinutes) continue;
      const hh = Math.floor(m / 60).toString().padStart(2, "0");
      const mm = (m % 60).toString().padStart(2, "0");
      slots.push(`${hh}:${mm}`);
    }
    return slots;
  }

  /**
   * Get day name in Spanish
   */
  getDayName(date: Date): string {
    const days = [
      "Domingo",
      "Lunes",
      "Martes",
      "Miércoles",
      "Jueves",
      "Viernes",
      "Sábado",
    ];
    return days[date.getDay()];
  }

  private normalizeAvailability(availability: any, date: Date): any {
    const normalized: any = {};
    const dateString = date.toISOString().split('T')[0];

    Object.keys(availability).forEach(profId => {
      const slots = availability[profId] || [];
      normalized[profId] = slots.map((slot: any) => ({
        ...slot,
        date: slot.date || dateString, // Assign date if missing
        start: slot.start,
        end: slot.end
      }));
    });

    return normalized;
  }

  private validateAvailabilityFormat(availability: any): boolean {
    if (!availability || typeof availability !== 'object') return false;

    return Object.values(availability).every((slots: any) => {
      return Array.isArray(slots) && slots.every((slot: any) =>
        slot.start && slot.end &&
        typeof slot.start === 'string' &&
        typeof slot.end === 'string'
      );
    });
  }

  private logDebug(message: string, data?: any) {
    if (this.debugMode) {
      console.log(`[AppointmentScheduler] ${message}`, data || '');
    }
  }

  private shouldUseExactTime(_services: any[], _searchType: string): boolean {
    return true;
  }

  timeToMinutes(timeStr: string): number {
    if (typeof timeStr !== "string") return 0;
    const [hours, minutes] = timeStr.split(":").map(Number);
    return (hours || 0) * 60 + (minutes || 0);
  }
}

export default AppointmentScheduler;
