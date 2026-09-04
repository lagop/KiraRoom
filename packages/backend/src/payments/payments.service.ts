import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";

@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  async getPayments(
    tenantId: string,
    professionalId: string | null,
    options: {
      page?: number;
      limit?: number;
      status?: string;
      clientId?: string;
      sortBy?: string;
      sortOrder?: "asc" | "desc";
      dateFrom?: string;
      dateTo?: string;
    },
  ) {
    const {
      page = 1,
      limit = 20,
      status,
      clientId,
      sortBy,
      sortOrder,
      dateFrom,
      dateTo,
    } = options;
    const skip = (page - 1) * limit;

    const where: any = { tenantId };
    if (status) where.status = status;
    if (clientId) where.clientId = clientId;

    // Filtrar solo pagos de citas del profesional (para usuarios STAFF)
    if (professionalId) {
      where.appointment = {
        professionalId: professionalId,
      };
    }

    // Date range filter
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) {
        const endOfDay = new Date(dateTo);
        endOfDay.setHours(23, 59, 59, 999);
        where.createdAt.lte = endOfDay;
      }
    }

    // Build orderBy dynamically
    const orderBy: any = {};
    const allowedSortFields = ["id", "createdAt", "amount", "status", "method"];
    const validSortField =
      sortBy && allowedSortFields.includes(sortBy) ? sortBy : "createdAt";
    const validSortOrder = sortOrder === "asc" ? "asc" : "desc";
    orderBy[validSortField] = validSortOrder;

    const [payments, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          client: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
          appointment: {
            select: {
              id: true,
              scheduledDate: true,
              status: true,
            },
          },
        },
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      payments,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getPaymentById(tenantId: string, paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        tenantId,
      },
      include: {
        client: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
        appointment: {
          select: {
            id: true,
            scheduledDate: true,
            status: true,
            service: {
              select: {
                name: true,
                price: true,
              },
            },
          },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException("Payment not found");
    }

    return payment;
  }

  async createPayment(
    tenantId: string,
    professionalId: string | null,
    data: {
      clientId: string;
      appointmentId?: string;
      amount: number;
      method:
        | "cash"
        | "card"
        | "bank_transfer"
        | "wallet"
        | "gift_card"
        | "loyalty_points";
      type?:
        | "appointment"
        | "deposit"
        | "product"
        | "service"
        | "gift_card"
        | "membership"
        | "other";
      status?: "pending" | "paid" | "failed" | "refunded";
      description?: string;
    },
  ) {
    const {
      clientId,
      appointmentId,
      amount,
      method,
      type = "appointment",
      status = "pending",
      description,
    } = data;

    const client = await this.prisma.client.findFirst({
      where: { id: clientId, tenantId },
    });

    if (!client) {
      throw new NotFoundException("Client not found");
    }

    if (appointmentId) {
      const whereCondition: any = {
        id: appointmentId,
        clientId,
        tenantId,
      };

      // Si el usuario es STAFF, validar que la cita le pertenece
      if (professionalId) {
        whereCondition.professionalId = professionalId;
      }

      const appointment = await this.prisma.appointment.findFirst({
        where: whereCondition,
      });

      if (!appointment) {
        const errorMessage = professionalId
          ? "Appointment not found for this professional"
          : "Appointment not found for this client";
        throw new NotFoundException(errorMessage);
      }
    }

    const payment = await this.prisma.payment.create({
      data: {
        tenantId,
        clientId,
        appointmentId,
        amount,
        type,
        method,
        status,
        description,
      },
    });

    if (status === "paid" && appointmentId) {
      await this.prisma.appointment.update({
        where: { id: appointmentId },
        data: { status: "completed" },
      });
    }

    return payment;
  }

  async updatePaymentStatus(
    tenantId: string,
    paymentId: string,
    status: "pending" | "paid" | "failed" | "refunded",
  ) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        tenantId,
      },
    });

    if (!payment) {
      throw new NotFoundException("Payment not found");
    }

    const updatedPayment = await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status },
    });

    if (status === "paid" && payment.appointmentId) {
      await this.prisma.appointment.update({
        where: { id: payment.appointmentId },
        data: { status: "completed" },
      });
    }

    return updatedPayment;
  }

  async getPaymentStats(tenantId: string, startDate?: Date, endDate?: Date) {
    const where: any = { tenantId };

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = startDate;
      if (endDate) where.createdAt.lte = endDate;
    }

    const [
      totalPayments,
      completedPayments,
      pendingPayments,
      failedPayments,
      totalRevenue,
    ] = await Promise.all([
      this.prisma.payment.count({ where }),
      this.prisma.payment.count({ where: { ...where, status: "paid" } }),
      this.prisma.payment.count({ where: { ...where, status: "pending" } }),
      this.prisma.payment.count({ where: { ...where, status: "failed" } }),
      this.prisma.payment.aggregate({
        where: { ...where, status: "paid" },
        _sum: { amount: true },
      }),
    ]);

    return {
      totalPayments,
      completedPayments,
      pendingPayments,
      failedPayments,
      totalRevenue: totalRevenue._sum.amount || 0,
    };
  }

  async refundPayment(tenantId: string, paymentId: string, reason?: string) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        tenantId,
      },
    });

    if (!payment) {
      throw new NotFoundException("Payment not found");
    }

    if (payment.status !== "paid") {
      throw new BadRequestException("Only paid payments can be refunded");
    }

    const updatedPayment = await this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: "refunded",
      },
    });

    if (payment.appointmentId) {
      await this.prisma.appointment.update({
        where: { id: payment.appointmentId },
        data: { status: "cancelled" },
      });
    }

    return updatedPayment;
  }

  async deletePayment(tenantId: string, paymentId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        id: paymentId,
        tenantId,
      },
    });

    if (!payment) {
      throw new NotFoundException("Payment not found");
    }

    if (!["pending", "failed"].includes(payment.status)) {
      throw new BadRequestException(
        "Only pending or failed payments can be deleted",
      );
    }

    await this.prisma.payment.delete({
      where: { id: paymentId },
    });

    return { success: true };
  }

  async getPaymentByStripeId(stripePaymentId: string, tenantId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        stripePaymentId,
        tenantId,
      },
    });

    return payment;
  }

  async getTodayPayments(tenantId: string, professionalId: string | null) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const where: any = {
      tenantId,
      createdAt: {
        gte: today,
        lt: tomorrow,
      },
    };

    // Filtrar solo pagos de citas del profesional (para usuarios STAFF)
    if (professionalId) {
      where.appointment = {
        professionalId: professionalId,
      };
    }

    const payments = await this.prisma.payment.findMany({
      where,
      include: {
        client: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        appointment: {
          select: {
            id: true,
            scheduledDate: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return payments;
  }

  async getPaymentsByAppointment(appointmentId: string) {
    const payments = await this.prisma.payment.findMany({
      where: { appointmentId },
      include: {
        client: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return payments;
  }

  async getPaymentsByClient(tenantId: string, clientId: string) {
    const payments = await this.prisma.payment.findMany({
      where: {
        tenantId,
        clientId,
      },
      include: {
        appointment: {
          select: {
            id: true,
            scheduledDate: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return payments;
  }

  async confirmPayment(tenantId: string, paymentIntentId: string) {
    // Find payment by stripe payment intent id or create a new one
    const payment = await this.prisma.payment.findFirst({
      where: {
        tenantId,
        stripePaymentId: paymentIntentId,
      },
    });

    if (!payment) {
      throw new NotFoundException("Payment not found for this payment intent");
    }

    const updatedPayment = await this.prisma.payment.update({
      where: { id: payment.id },
      data: { status: "paid" },
    });

    if (payment.appointmentId) {
      await this.prisma.appointment.update({
        where: { id: payment.appointmentId },
        data: { status: "completed" },
      });
    }

    return updatedPayment;
  }

  async processDeposit(
    tenantId: string,
    appointmentId: string,
    amount: number,
    method: "card" | "cash",
  ) {
    const appointment = await this.prisma.appointment.findFirst({
      where: {
        id: appointmentId,
        tenantId,
      },
    });

    if (!appointment) {
      throw new NotFoundException("Appointment not found");
    }

    const payment = await this.prisma.payment.create({
      data: {
        tenantId,
        clientId: appointment.clientId,
        appointmentId,
        amount,
        type: "deposit",
        method,
        status: "paid",
        description: "Deposit payment",
      },
    });

    // Update appointment with deposit info
    await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        depositPaid: true,
        depositAmount: amount,
      },
    });

    return payment;
  }

  async collectBalance(
    tenantId: string,
    appointmentId: string,
    amount: number,
    method: "card" | "cash",
  ) {
    const appointment = await this.prisma.appointment.findFirst({
      where: {
        id: appointmentId,
        tenantId,
      },
    });

    if (!appointment) {
      throw new NotFoundException("Appointment not found");
    }

    const payment = await this.prisma.payment.create({
      data: {
        tenantId,
        clientId: appointment.clientId,
        appointmentId,
        amount,
        type: "appointment",
        method,
        status: "paid",
        description: "Balance payment",
      },
    });

    // Update appointment status to completed
    await this.prisma.appointment.update({
      where: { id: appointmentId },
      data: { status: "completed" },
    });

    return payment;
  }
}
