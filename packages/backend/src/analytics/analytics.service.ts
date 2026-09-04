import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";

export interface DashboardStats {
  totalRevenue: number;
  totalAppointments: number;
  newClients: number;
  avgOrderValue: number;
  revenueChange: number;
  appointmentsChange: number;
  clientsChange: number;
  orderValueChange: number;
}

export interface RevenueDataPoint {
  month: string;
  revenue: number;
}

export interface ServicePopularity {
  name: string;
  count: number;
  percentage: number;
}

export interface AppointmentStatusData {
  name: string;
  count: number;
  color: string;
}

export interface AnalyticsOverview {
  stats: DashboardStats;
  revenueData: RevenueDataPoint[];
  servicePopularity: ServicePopularity[];
  appointmentStatus: AppointmentStatusData[];
  topServices: { name: string; count: number; revenue: number }[];
  topProfessionals: { name: string; appointments: number; revenue: number }[];
  dailyMetrics: { date: string; appointments: number; revenue: number }[];
}

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Get comprehensive analytics overview for a tenant
   */
  async getOverview(
    tenantId: string,
    months: number = 6,
    professionalId?: string | null,
  ): Promise<AnalyticsOverview> {
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - months, 1);
    const previousMonthStart = new Date(
      now.getFullYear(),
      now.getMonth() - 1,
      1,
    );
    const previousMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

    // Get current period stats
    const [currentRevenue, previousRevenue] = await Promise.all([
      this.getRevenue(tenantId, startDate, now),
      this.getRevenue(tenantId, previousMonthStart, previousMonthEnd),
    ]);

    const [currentAppointments, previousAppointments] = await Promise.all([
      this.getAppointmentCount(tenantId, startDate, now),
      this.getAppointmentCount(tenantId, previousMonthStart, previousMonthEnd),
    ]);

    const [currentClients, previousClients] = await Promise.all([
      this.getNewClientsCount(tenantId, startDate, now),
      this.getNewClientsCount(tenantId, previousMonthStart, previousMonthEnd),
    ]);

    const avgOrderValue =
      currentAppointments > 0 ? currentRevenue / currentAppointments : 0;
    const previousAvgOrderValue =
      previousAppointments > 0 ? previousRevenue / previousAppointments : 0;

    // Calculate changes
    const revenueChange =
      previousRevenue > 0
        ? ((currentRevenue - previousRevenue) / previousRevenue) * 100
        : 0;
    const appointmentsChange =
      previousAppointments > 0
        ? ((currentAppointments - previousAppointments) /
            previousAppointments) *
          100
        : 0;
    const clientsChange =
      previousClients > 0
        ? ((currentClients - previousClients) / previousClients) * 100
        : 0;
    const orderValueChange =
      previousAvgOrderValue > 0
        ? ((avgOrderValue - previousAvgOrderValue) / previousAvgOrderValue) *
          100
        : 0;

    const stats: DashboardStats = {
      totalRevenue: currentRevenue,
      totalAppointments: currentAppointments,
      newClients: currentClients,
      avgOrderValue,
      revenueChange: Math.round(revenueChange * 10) / 10,
      appointmentsChange: Math.round(appointmentsChange * 10) / 10,
      clientsChange: Math.round(clientsChange * 10) / 10,
      orderValueChange: Math.round(orderValueChange * 10) / 10,
    };

    // Get revenue data by month
    const revenueData = await this.getRevenueByMonth(
      tenantId,
      months,
      professionalId,
    );

    // Get service popularity
    const servicePopularity = await this.getServicePopularity(
      tenantId,
      startDate,
      now,
    );

    // Get appointment status breakdown
    const appointmentStatus = await this.getAppointmentStatus(
      tenantId,
      startDate,
      now,
    );

    // Get top services
    const topServices = await this.getTopServices(
      tenantId,
      startDate,
      now,
      5,
      professionalId,
    );

    // Get top professionals
    const topProfessionals = await this.getTopProfessionals(
      tenantId,
      startDate,
      now,
      5,
      professionalId,
    );

    // Get daily metrics
    const dailyMetrics = await this.getDailyMetrics(
      tenantId,
      startDate,
      now,
      professionalId,
    );

    return {
      stats,
      revenueData,
      servicePopularity,
      appointmentStatus,
      topServices,
      topProfessionals,
      dailyMetrics,
    };
  }

  /**
   * Get revenue for a date range
   */
  private async getRevenue(
    tenantId: string,
    startDate: Date,
    endDate: Date,
    professionalId?: string | null,
  ): Promise<number> {
    const where: any = {
      tenantId,
      scheduledDate: { gte: startDate, lte: endDate },
      status: { in: ["completed", "confirmed"] },
    };

    // Filtrar por profesional si se especifica (para Staff)
    if (professionalId) {
      where.professionalId = professionalId;
    }

    const appointments = await this.prisma.appointment.findMany({
      where,
      select: { totalAmount: true },
    });

    return appointments.reduce(
      (sum, apt) => sum + Number(apt.totalAmount || 0),
      0,
    );
  }

  /**
   * Get appointment count for a date range
   */
  async getAppointmentCount(
    tenantId: string,
    startDate: Date,
    endDate: Date,
    professionalId?: string | null,
  ): Promise<number> {
    const where: any = {
      tenantId,
      scheduledDate: { gte: startDate, lte: endDate },
    };

    // Filtrar por profesional si se especifica (para Staff)
    if (professionalId) {
      where.professionalId = professionalId;
    }

    return this.prisma.appointment.count({
      where,
    });
  }

  /**
   * Get new clients count (created in date range)
   */
  async getNewClientsCount(
    tenantId: string,
    startDate: Date,
    endDate: Date,
    professionalId?: string | null,
  ): Promise<number> {
    const where: any = {
      tenantId,
      createdAt: { gte: startDate, lte: endDate },
    };

    // Para Staff, contar solo clientes que han tenido citas con ese profesional
    if (professionalId) {
      where.appointments = {
        some: {
          professionalId: professionalId,
        },
      };
    }

    return this.prisma.client.count({
      where,
    });
  }

  /**
   * Get revenue by month
   */
  private async getRevenueByMonth(
    tenantId: string,
    months: number,
    professionalId?: string | null,
  ): Promise<RevenueDataPoint[]> {
    const result: RevenueDataPoint[] = [];
    const now = new Date();

    for (let i = months - 1; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);

      const revenue = await this.getRevenue(
        tenantId,
        monthStart,
        monthEnd,
        professionalId,
      );

      result.push({
        month: monthStart.toLocaleDateString("en-US", { month: "short" }),
        revenue,
      });
    }

    return result;
  }

  /**
   * Get service popularity
   */
  private async getServicePopularity(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<ServicePopularity[]> {
    const appointments = await this.prisma.appointment.findMany({
      where: {
        tenantId,
        scheduledDate: { gte: startDate, lte: endDate },
      },
      include: {
        service: true,
      },
    });

    const serviceCounts: Record<string, number> = {};
    let totalCount = 0;

    appointments.forEach((apt) => {
      const serviceName = apt.service?.name || "Unknown";
      serviceCounts[serviceName] = (serviceCounts[serviceName] || 0) + 1;
      totalCount++;
    });

    const sorted = Object.entries(serviceCounts)
      .map(([name, count]) => ({
        name,
        count,
        percentage: totalCount > 0 ? Math.round((count / totalCount) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    return sorted.slice(0, 10);
  }

  /**
   * Get appointment status breakdown
   */
  public async getAppointmentStatus(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<AppointmentStatusData[]> {
    const statusCounts = await this.prisma.appointment.groupBy({
      by: ["status"],
      where: {
        tenantId,
        scheduledDate: { gte: startDate, lte: endDate },
      },
      _count: true,
    });

    const statusColors: Record<string, string> = {
      completed: "bg-green-500",
      confirmed: "bg-blue-500",
      pending: "bg-yellow-500",
      cancelled: "bg-red-500",
      no_show: "bg-gray-500",
      in_progress: "bg-purple-500",
    };

    const statusNames: Record<string, string> = {
      completed: "Completed",
      confirmed: "Confirmed",
      pending: "Pending",
      cancelled: "Cancelled",
      no_show: "No Show",
      in_progress: "In Progress",
    };

    return statusCounts.map((s) => ({
      name: statusNames[s.status] || s.status,
      count: s._count,
      color: statusColors[s.status] || "bg-gray-500",
    }));
  }

  /**
   * Get appointment status evolution over time
   */
  async getAppointmentStatusEvolution(
    tenantId: string,
    status: string,
    months: number = 6,
  ): Promise<{ period: string; count: number }[]> {
    const now = new Date();
    const results: { period: string; count: number }[] = [];

    // Map display name to database status
    const statusMap: Record<string, string> = {
      Completed: "completed",
      Confirmed: "confirmed",
      Pending: "pending",
      Cancelled: "cancelled",
      "No Show": "no_show",
      "In Progress": "in_progress",
    };

    const dbStatus = statusMap[status] || status;

    for (let i = months - 1; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);

      const count = await this.prisma.appointment.count({
        where: {
          tenantId,
          status: dbStatus as any,
          scheduledDate: { gte: monthStart, lte: monthEnd },
        },
      });

      results.push({
        period: monthStart.toLocaleDateString("en-US", {
          month: "short",
          year: "2-digit",
        }),
        count,
      });
    }

    return results;
  }

  /**
   * Get all appointment statuses evolution over time (stacked bar chart data)
   */
  async getAppointmentStatusesEvolution(
    tenantId: string,
    months: number = 6,
  ): Promise<
    {
      period: string;
      Completed: number;
      Confirmed: number;
      Pending: number;
      Cancelled: number;
      "No Show": number;
      "In Progress": number;
    }[]
  > {
    const now = new Date();
    const results: {
      period: string;
      Completed: number;
      Confirmed: number;
      Pending: number;
      Cancelled: number;
      "No Show": number;
      "In Progress": number;
    }[] = [];

    const statusNames = [
      "completed",
      "confirmed",
      "pending",
      "cancelled",
      "no_show",
      "in_progress",
    ];
    const displayNames: Record<string, string> = {
      completed: "Completed",
      confirmed: "Confirmed",
      pending: "Pending",
      cancelled: "Cancelled",
      no_show: "No Show",
      in_progress: "In Progress",
    };

    for (let i = months - 1; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);

      const monthData: {
        period: string;
        Completed: number;
        Confirmed: number;
        Pending: number;
        Cancelled: number;
        "No Show": number;
        "In Progress": number;
      } = {
        period: monthStart.toLocaleDateString("en-US", {
          month: "short",
          year: "2-digit",
        }),
        Completed: 0,
        Confirmed: 0,
        Pending: 0,
        Cancelled: 0,
        "No Show": 0,
        "In Progress": 0,
      };

      // Get counts for each status
      for (const status of statusNames) {
        const count = await this.prisma.appointment.count({
          where: {
            tenantId,
            status: status as any,
            scheduledDate: { gte: monthStart, lte: monthEnd },
          },
        });

        // Assign count to the correct property
        const displayName = displayNames[status];
        switch (displayName) {
          case "Completed":
            monthData.Completed = count;
            break;
          case "Confirmed":
            monthData.Confirmed = count;
            break;
          case "Pending":
            monthData.Pending = count;
            break;
          case "Cancelled":
            monthData.Cancelled = count;
            break;
          case "No Show":
            monthData["No Show"] = count;
            break;
          case "In Progress":
            monthData["In Progress"] = count;
            break;
        }
      }

      results.push(monthData);
    }

    return results;
  }

  /**
   * Get top services by revenue and count
   */
  private async getTopServices(
    tenantId: string,
    startDate: Date,
    endDate: Date,
    limit: number,
    professionalId?: string | null,
  ): Promise<{ name: string; count: number; revenue: number }[]> {
    const where: any = {
      tenantId,
      scheduledDate: { gte: startDate, lte: endDate },
    };

    // Filtrar por profesional si se especifica (para Staff)
    if (professionalId) {
      where.professionalId = professionalId;
    }

    const appointments = await this.prisma.appointment.findMany({
      where,
      include: {
        service: true,
      },
    });

    const serviceStats: Record<string, { count: number; revenue: number }> = {};

    appointments.forEach((apt) => {
      const serviceName = apt.service?.name || "Unknown";
      if (!serviceStats[serviceName]) {
        serviceStats[serviceName] = { count: 0, revenue: 0 };
      }
      serviceStats[serviceName].count++;
      serviceStats[serviceName].revenue += Number(apt.price || 0);
    });

    return Object.entries(serviceStats)
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);
  }

  /**
   * Get top professionals by appointments and revenue
   */
  async getTopProfessionals(
    tenantId: string,
    startDate: Date,
    endDate: Date,
    limit: number,
    professionalId?: string | null,
  ): Promise<
    {
      id: string;
      name: string;
      firstName: string;
      lastName: string;
      profileImage: string | null;
      appointments: number;
      revenue: number;
    }[]
  > {
    const where: any = {
      tenantId,
      scheduledDate: { gte: startDate, lte: endDate },
    };

    // Filtrar por profesional si se especifica (para Staff)
    if (professionalId) {
      where.professionalId = professionalId;
    }

    const appointments = await this.prisma.appointment.findMany({
      where,
      include: {
        professional: true,
      },
    });

    // Filter out appointments without professional in JavaScript
    const appointmentsWithProfessional = appointments.filter(
      (apt) => apt.professional,
    );

    const professionalStats: Record<
      string,
      {
        id: string;
        name: string;
        firstName: string;
        lastName: string;
        profileImage: string | null;
        appointments: number;
        revenue: number;
      }
    > = {};

    appointmentsWithProfessional.forEach((apt) => {
      if (!apt.professional) return;

      const profKey = apt.professional.id;
      const profName = `${apt.professional.firstName} ${apt.professional.lastName}`;
      const profImage = apt.professional.profileImage;

      if (!professionalStats[profKey]) {
        professionalStats[profKey] = {
          id: apt.professional.id,
          firstName: apt.professional.firstName,
          lastName: apt.professional.lastName,
          name: profName,
          profileImage: profImage,
          appointments: 0,
          revenue: 0,
        };
      }
      professionalStats[profKey].appointments++;
      professionalStats[profKey].revenue += Number(apt.totalAmount || 0);
    });

    return Object.values(professionalStats)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, limit);
  }

  /**
   * Get daily metrics for a date range
   */
  private async getDailyMetrics(
    tenantId: string,
    startDate: Date,
    endDate: Date,
    professionalId?: string | null,
  ): Promise<{ date: string; appointments: number; revenue: number }[]> {
    const where: any = {
      tenantId,
      scheduledDate: { gte: startDate, lte: endDate },
      status: { in: ["completed", "confirmed"] },
    };

    // Filtrar por profesional si se especifica (para Staff)
    if (professionalId) {
      where.professionalId = professionalId;
    }

    const appointments = await this.prisma.appointment.findMany({
      where,
      select: {
        scheduledDate: true,
        totalAmount: true,
      },
    });

    const dailyData: Record<string, { appointments: number; revenue: number }> =
      {};

    // Initialize all days in range
    const current = new Date(startDate);
    while (current <= endDate) {
      const dateKey = current.toISOString().split("T")[0];
      dailyData[dateKey] = { appointments: 0, revenue: 0 };
      current.setDate(current.getDate() + 1);
    }

    // Count appointments
    appointments.forEach((apt) => {
      const dateKey = apt.scheduledDate.toISOString().split("T")[0];
      if (dailyData[dateKey]) {
        dailyData[dateKey].appointments++;
        dailyData[dateKey].revenue += Number(apt.totalAmount || 0);
      }
    });

    return Object.entries(dailyData)
      .map(([date, stats]) => ({
        date,
        ...stats,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Get revenue report with date range
   */
  async getRevenueReport(
    tenantId: string,
    startDate: string,
    endDate: string,
  ): Promise<{
    total: number;
    byDay: { date: string; revenue: number }[];
    byService: { service: string; revenue: number }[];
    byProfessional: { professional: string; revenue: number }[];
  }> {
    const start = new Date(startDate);
    const end = new Date(endDate);

    const total = await this.getRevenue(tenantId, start, end);

    // By day
    const byDayResult = await this.getDailyMetrics(tenantId, start, end);
    const byDay = byDayResult.map((d) => ({
      date: d.date,
      revenue: d.revenue,
    }));

    // By service
    const byServiceRaw = await this.getTopServices(tenantId, start, end, 100);
    const byService = byServiceRaw.map((s) => ({
      service: s.name,
      revenue: s.revenue,
    }));

    // By professional
    const byProfessionalRaw = await this.getTopProfessionals(
      tenantId,
      start,
      end,
      100,
    );
    const byProfessional = byProfessionalRaw.map((p) => ({
      professional: p.name,
      revenue: p.revenue,
    }));

    return { total, byDay, byService, byProfessional };
  }

  /**
   * Get appointments report
   */
  async getAppointmentsReport(
    tenantId: string,
    startDate: string,
    endDate: string,
  ): Promise<{
    total: number;
    completed: number;
    cancelled: number;
    noShow: number;
    byDay: { date: string; count: number }[];
    byProfessional: { professional: string; count: number }[];
  }> {
    const start = new Date(startDate);
    const end = new Date(endDate);

    const appointments = await this.prisma.appointment.findMany({
      where: {
        tenantId,
        scheduledDate: { gte: start, lte: end },
      },
      include: {
        professional: true,
      },
    });

    const total = appointments.length;
    const completed = appointments.filter(
      (a) => a.status === "completed",
    ).length;
    const cancelled = appointments.filter(
      (a) => a.status === "cancelled",
    ).length;
    const noShow = appointments.filter((a) => a.status === "no_show").length;

    // By day
    const byDayMap: Record<string, number> = {};
    appointments.forEach((apt) => {
      const dateKey = apt.scheduledDate.toISOString().split("T")[0];
      byDayMap[dateKey] = (byDayMap[dateKey] || 0) + 1;
    });
    const byDay = Object.entries(byDayMap)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // By professional
    const byProfMap: Record<string, number> = {};
    appointments.forEach((apt) => {
      const profName = apt.professional
        ? `${apt.professional.firstName} ${apt.professional.lastName}`
        : "Unknown";
      byProfMap[profName] = (byProfMap[profName] || 0) + 1;
    });
    const byProfessional = Object.entries(byProfMap)
      .map(([professional, count]) => ({ professional, count }))
      .sort((a, b) => b.count - a.count);

    return { total, completed, cancelled, noShow, byDay, byProfessional };
  }
}
