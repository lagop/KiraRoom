import { Injectable, NotFoundException, BadRequestException, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { WalletService } from '../payments/services/wallet.service';
import { LoyaltyService } from '../loyalty/loyalty.service';

export interface CartItem {
  serviceId?: string;
  name: string;
  price: number;
  quantity: number;
}

export interface CreatePosOrderDto {
  tenantId: string;
  clientId?: string;
  clientInfo?: {
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
  };
  items: CartItem[];
  payments: {
    method: 'card' | 'cash' | 'bank_transfer' | 'wallet' | 'gift_card';
    amount: number;
  }[];
  notes?: string;
  /** Appointments this ticket pays for (the till's "charge appointment" flow). */
  appointmentIds?: string[];
  /** A loyalty reward the client spends points on: comes off the total. */
  loyaltyRewardId?: string;
}

@Injectable()
export class PosService {
  private readonly logger = new Logger(PosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    @Optional() private readonly loyalty?: LoyaltyService,
  ) {}

  /**
   * Get POS dashboard data for a tenant
   */
  async getDashboard(tenantId: string, date?: string) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    
    // Get today's payments - use start of day to start of next day (exclusive)
    const dayStart = new Date(`${targetDate}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    
    const payments = await this.prisma.payment.findMany({
      where: {
        tenantId,
        createdAt: {
          gte: dayStart,
          lt: dayEnd,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Calculate totals
    const totalSales = payments
      .filter((p) => p.status === 'paid')
      .reduce((sum, p) => sum + p.amount, 0);

    const totalTransactions = payments.filter((p) => p.status === 'paid').length;
    const pendingPayments = payments.filter((p) => p.status === 'pending').length;
    const refundedAmount = payments
      .filter((p) => p.status === 'refunded')
      .reduce((sum, p) => sum + p.amount, 0);

    // Get payment method breakdown
    const paymentBreakdown = payments
      .filter((p) => p.status === 'paid')
      .reduce((acc, p) => {
        if (!acc[p.method]) {
          acc[p.method] = { amount: 0, count: 0 };
        }
        acc[p.method].amount += p.amount;
        acc[p.method].count += 1;
        return acc;
      }, {} as Record<string, { amount: number; count: number }>);

    // Get top services sold today
    const todayAppointments = await this.prisma.appointment.findMany({
      where: {
        tenantId,
        createdAt: {
          gte: new Date(`${targetDate}T00:00:00Z`),
          lt: new Date(`${targetDate}T23:59:59Z`),
        },
        paymentStatus: 'paid',
      },
      include: { service: true },
    });

    const serviceSales = todayAppointments.reduce((acc, apt) => {
      const serviceName = apt.service?.name || 'Unknown';
      if (!acc[serviceName]) {
        acc[serviceName] = { count: 0, revenue: 0 };
      }
      acc[serviceName].count += 1;
      acc[serviceName].revenue += Number(apt.price);
      return acc;
    }, {} as Record<string, { count: number; revenue: number }>);

    return {
      date: targetDate,
      totalSales,
      totalTransactions,
      pendingPayments,
      refundedAmount,
      paymentBreakdown: Object.entries(paymentBreakdown).map(([method, data]) => ({
        method,
        ...data,
      })),
      topServices: Object.entries(serviceSales)
        .map(([name, data]) => ({ name, ...data }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10),
    };
  }

  /**
   * Get available services for POS (only active ones)
   */
  async getServices(tenantId: string) {
    return this.prisma.service.findMany({
      where: { tenantId, isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Get clients for POS
   */
  async getClients(tenantId: string, search?: string) {
    const where: any = { tenantId, status: 'active' };
    
    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }
    
    return this.prisma.client.findMany({
      where,
      orderBy: { firstName: 'asc' },
      take: 50,
    });
  }

  /**
   * Process a POS checkout/sale
   */
  async processCheckout(dto: CreatePosOrderDto) {
    const { tenantId, clientId, clientInfo, items } = dto;
    const payments = dto.payments ?? [];
    // One id for the whole ticket, stamped on each of its payments, so the
    // loyalty points it earns or spends can be found again on a refund.
    const saleId = randomUUID();

    // Calculate totals (amounts are in cents)
    const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

    const appointmentIds = [...new Set(dto.appointmentIds ?? [])];
    if (appointmentIds.length > 0) {
      const found = await this.prisma.appointment.count({
        where: { id: { in: appointmentIds }, tenantId },
      });
      if (found !== appointmentIds.length) {
        throw new NotFoundException('Appointment not found');
      }
    }

    let finalClientId = clientId;

    // If no clientId provided, create or find walk-in client
    if (!clientId && clientInfo) {
      const existingClient = clientInfo.phone
        ? await this.prisma.client.findFirst({
            where: { tenantId, phone: clientInfo.phone },
          })
        : null;

      if (existingClient) {
        finalClientId = existingClient.id;
      } else {
        const newClient = await this.prisma.client.create({
          data: {
            tenantId,
            firstName: clientInfo.firstName,
            lastName: clientInfo.lastName,
            email: clientInfo.email,
            phone: clientInfo.phone,
            status: 'active',
          },
        });
        finalClientId = newClient.id;
      }
    }

    // Points spent on a reward come off the ticket before it is paid.
    let loyaltyDiscount = 0;
    let pointsSpent = 0;
    let rewardName: string | undefined;
    if (dto.loyaltyRewardId) {
      if (!this.loyalty) throw new BadRequestException('Loyalty is not available');
      const redeemed = await this.loyalty.redeemAtSale(tenantId, {
        clientId: finalClientId,
        rewardId: dto.loyaltyRewardId,
        saleId,
        items: items.map((i) => ({ serviceId: i.serviceId, price: i.price, quantity: i.quantity })),
        subtotalCents: subtotal,
        appointmentId: appointmentIds[0] ?? null,
      });
      loyaltyDiscount = redeemed.discountCents;
      pointsSpent = redeemed.pointsSpent;
      rewardName = redeemed.rewardName;
    }
    const total = subtotal - loyaltyDiscount;

    // Verify payment amounts match total
    const paymentTotal = payments.reduce((sum, p) => sum + p.amount, 0);
    if (paymentTotal < total) {
      if (pointsSpent) await this.loyalty?.cancelSaleRedemption(tenantId, saleId, 'Venta no completada');
      throw new BadRequestException('Payment amount is less than order total');
    }

    // Process payments
    const paymentRecords = [];
    try {
      for (const payment of payments) {
        // "Card" at the till is the salon's own card terminal: the money is
        // already taken when the sale is recorded. It used to create a Stripe
        // PaymentIntent for 100 times the amount (cents passed to a method that
        // multiplied by 100), with the platform's Stripe account when the salon
        // had none, which nobody ever confirmed: the sale stayed "pending" and
        // out of the day's card total.

        // Process wallet payments
        if (payment.method === 'wallet' && finalClientId) {
          await this.walletService.deductFunds(tenantId, finalClientId, payment.amount, 'POS Payment');
        }

        // Create payment record
        const paymentRecord = await this.prisma.payment.create({
          data: {
            tenantId,
            clientId: finalClientId,
            amount: payment.amount,
            currency: 'EUR',
            type: 'service',
            status: 'paid',
            method: payment.method as any,
            description: `POS Sale: ${items.map(i => i.name).join(', ')}`,
            metadata: {
              posSaleId: saleId,
              ...(appointmentIds.length ? { appointmentIds } : {}),
              ...(loyaltyDiscount ? { loyaltyDiscount, loyaltyRewardId: dto.loyaltyRewardId } : {}),
            },
          },
        });
        paymentRecords.push(paymentRecord);
      }
    } catch (err) {
      // Nothing was sold: give the points back.
      if (pointsSpent) await this.loyalty?.cancelSaleRedemption(tenantId, saleId, 'Venta no completada');
      throw err;
    }

    // Points for the sale. An appointment's ticket earns through the
    // appointment instead (once it is completed and paid), never both.
    let pointsEarned = 0;
    if (this.loyalty) {
      try {
        if (appointmentIds.length > 0) {
          for (const id of appointmentIds) {
            const r = await this.loyalty.settleAppointment(tenantId, id);
            pointsEarned += r?.awarded ?? 0;
          }
        } else {
          pointsEarned = await this.loyalty.earnForSale(tenantId, {
            clientId: finalClientId,
            saleId,
            basisCents: total,
            isVisit: items.some((i) => !!i.serviceId),
          });
        }
      } catch (err) {
        // The sale stands; the hourly sweep retries appointments.
        this.logger.warn(`loyalty points for sale ${saleId} failed: ${(err as Error).message}`);
      }
    }

    return {
      orderId: `POS-${Date.now()}`,
      saleId,
      clientId: finalClientId,
      items,
      subtotal,
      total,
      payments: paymentRecords,
      loyalty: { pointsEarned, pointsSpent, discount: loyaltyDiscount, rewardName },
      status: 'completed',
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Process a quick sale (single item, immediate payment)
   */
  async quickSale(tenantId: string, serviceId: string, paymentMethod: 'cash' | 'card', clientId?: string) {
    const service = await this.prisma.service.findUnique({ where: { id: serviceId } });
    
    if (!service) {
      throw new NotFoundException('Service not found');
    }

    // Convert price to cents (same as checkout)
    const amount = Math.round(Number(service.price) * 100);
    const saleId = randomUUID();
    // Card means the salon's terminal; see processCheckout.

    const payment = await this.prisma.payment.create({
      data: {
        tenantId,
        clientId,
        amount,
        currency: service.currency || 'EUR',
        type: 'service',
        status: 'paid',
        method: paymentMethod as any,
        description: `Quick Sale: ${service.name}`,
        metadata: { posSaleId: saleId },
      },
    });

    let pointsEarned = 0;
    try {
      pointsEarned =
        (await this.loyalty?.earnForSale(tenantId, { clientId, saleId, basisCents: amount, isVisit: true })) ?? 0;
    } catch (err) {
      this.logger.warn(`loyalty points for quick sale ${saleId} failed: ${(err as Error).message}`);
    }

    return {
      id: payment.id,
      service: { name: service.name, price: service.price },
      amount,
      paymentMethod,
      status: payment.status,
      loyalty: { pointsEarned },
    };
  }

  /**
   * Get order/receipt details
   */
  async getOrder(orderId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: orderId },
    });

    if (!payment) {
      throw new NotFoundException('Order not found');
    }

    const client = payment.clientId
      ? await this.prisma.client.findUnique({ where: { id: payment.clientId } })
      : null;

    return {
      id: payment.id,
      client: client
        ? { name: `${client.firstName} ${client.lastName}`, email: client.email, phone: client.phone }
        : null,
      amount: payment.amount,
      paymentMethod: payment.method,
      status: payment.status,
      createdAt: payment.createdAt,
    };
  }

  /**
   * Get daily sales report
   */
  async getDailyReport(tenantId: string, date: string) {
    const startDate = new Date(`${date}T00:00:00Z`);
    const endDate = new Date(`${date}T23:59:59Z`);

    const payments = await this.prisma.payment.findMany({
      where: {
        tenantId,
        createdAt: { gte: startDate, lte: endDate },
      },
      include: { client: true },
    });

    const paidPayments = payments.filter((p) => p.status === 'paid');
    const refundedPayments = payments.filter((p) => p.status === 'refunded');

    // Group by hour
    const hourlySales = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      count: 0,
      amount: 0,
    }));

    paidPayments.forEach((payment) => {
      const hour = new Date(payment.createdAt).getHours();
      hourlySales[hour].count += 1;
      hourlySales[hour].amount += payment.amount;
    });

    return {
      date,
      summary: {
        totalSales: paidPayments.reduce((sum, p) => sum + p.amount, 0),
        totalTransactions: paidPayments.length,
        refundedAmount: refundedPayments.reduce((sum, p) => sum + p.amount, 0),
        refundedCount: refundedPayments.length,
      },
      hourlySales,
      payments: paidPayments.map((p) => ({
        id: p.id,
        amount: p.amount,
        method: p.method,
        client: p.client ? `${p.client.firstName} ${p.client.lastName}` : 'Walk-in',
        time: p.createdAt,
      })),
    };
  }
}
