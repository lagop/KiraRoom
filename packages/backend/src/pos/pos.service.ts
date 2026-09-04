import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { StripeService } from '../payments/services/stripe.service';
import { WalletService } from '../payments/services/wallet.service';

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
}

@Injectable()
export class PosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly walletService: WalletService,
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
    const { tenantId, clientId, clientInfo, items, payments, notes } = dto;

    // Calculate totals (amounts are in cents)
    const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const total = subtotal;

    // Verify payment amounts match total
    const paymentTotal = payments.reduce((sum, p) => sum + p.amount, 0);
    if (paymentTotal < total) {
      throw new BadRequestException('Payment amount is less than order total');
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

    // Process payments
    const paymentRecords = [];
    
    for (const payment of payments) {
      let stripePaymentId: string | undefined;
      
      // Process card payments through Stripe
      if (payment.method === 'card') {
        try {
          const paymentIntent = await this.stripeService.createPaymentIntent(
            tenantId,
            payment.amount,
            finalClientId,
          );
          stripePaymentId = paymentIntent.id;
        } catch (error) {
          console.error('Stripe payment intent creation failed:', error);
        }
      }

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
          status: payment.method === 'card' ? 'pending' : 'paid',
          method: payment.method as any,
          stripePaymentId,
          description: `POS Sale: ${items.map(i => i.name).join(', ')}`,
        },
      });
      paymentRecords.push(paymentRecord);
    }

    return {
      orderId: `POS-${Date.now()}`,
      clientId: finalClientId,
      items,
      subtotal,
      total,
      payments: paymentRecords,
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
    let stripePaymentId: string | undefined;

    if (paymentMethod === 'card') {
      try {
        const paymentIntent = await this.stripeService.createPaymentIntent(
          tenantId,
          amount,
          clientId,
        );
        stripePaymentId = paymentIntent.id;
      } catch (error) {
        console.error('Stripe payment intent creation failed:', error);
      }
    }

    const payment = await this.prisma.payment.create({
      data: {
        tenantId,
        clientId,
        amount,
        currency: service.currency || 'EUR',
        type: 'service',
        status: paymentMethod === 'cash' ? 'paid' : 'pending',
        method: paymentMethod as any,
        stripePaymentId,
        description: `Quick Sale: ${service.name}`,
      },
    });

    return {
      id: payment.id,
      service: { name: service.name, price: service.price },
      amount,
      paymentMethod,
      status: payment.status,
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
