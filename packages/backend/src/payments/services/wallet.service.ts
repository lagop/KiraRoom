import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  // ============ WALLET OPERATIONS ============

  async getOrCreateWallet(tenantId: string, clientId: string) {
    let wallet = await this.prisma.clientWallet.findFirst({
      where: { tenantId, clientId },
    });

    if (!wallet) {
      wallet = await this.prisma.clientWallet.create({
        data: {
          tenantId,
          clientId,
          balance: 0,
          totalEarned: 0,
          totalSpent: 0,
          loyaltyPoints: 0,
        },
      });
    }

    return wallet;
  }

  async getWallet(tenantId: string, clientId: string) {
    const wallet = await this.prisma.clientWallet.findFirst({
      where: { tenantId, clientId },
      include: {
        client: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    return wallet;
  }

  async getWalletById(tenantId: string, walletId: string) {
    const wallet = await this.prisma.clientWallet.findFirst({
      where: { id: walletId, tenantId },
      include: {
        client: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        transactions: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    return wallet;
  }

  async addFunds(
    tenantId: string,
    clientId: string,
    amount: number,
    description?: string,
    referenceType?: string,
    referenceId?: string,
  ) {
    const wallet = await this.getOrCreateWallet(tenantId, clientId);

    // Create wallet transaction
    const transaction = await this.prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'credit' as any,
        amount,
        balanceAfter: wallet.balance + amount,
        description: description || 'Deposit',
        referenceType,
        referenceId,
      },
    });

    // Update wallet balance
    const updatedWallet = await this.prisma.clientWallet.update({
      where: { id: wallet.id },
      data: {
        balance: { increment: amount },
      },
    });

    return { wallet: updatedWallet, transaction };
  }

  async deductFunds(
    tenantId: string,
    clientId: string,
    amount: number,
    description?: string,
    referenceType?: string,
    referenceId?: string,
  ) {
    const wallet = await this.getOrCreateWallet(tenantId, clientId);

    if (wallet.balance < amount) {
      throw new Error('Insufficient wallet balance');
    }

    // Create wallet transaction
    const transaction = await this.prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'debit' as any,
        amount,
        balanceAfter: wallet.balance - amount,
        description: description || 'Payment',
        referenceType,
        referenceId,
      },
    });

    // Update wallet balance
    const updatedWallet = await this.prisma.clientWallet.update({
      where: { id: wallet.id },
      data: {
        balance: { decrement: amount },
      },
    });

    return { wallet: updatedWallet, transaction };
  }

  async getTransactions(tenantId: string, walletId: string, limit = 20) {
    const wallet = await this.prisma.clientWallet.findFirst({
      where: { id: walletId, tenantId },
    });

    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    return this.prisma.walletTransaction.findMany({
      where: { walletId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getClientTransactions(tenantId: string, clientId: string, limit = 20) {
    const wallet = await this.prisma.clientWallet.findFirst({
      where: { tenantId, clientId },
    });

    if (!wallet) {
      return [];
    }

    return this.prisma.walletTransaction.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getWalletStats(tenantId: string, clientId: string) {
    const wallet = await this.prisma.clientWallet.findFirst({
      where: { tenantId, clientId },
    });

    if (!wallet) {
      return {
        balance: 0,
        totalEarned: 0,
        totalSpent: 0,
        loyaltyPoints: 0,
        transactionCount: 0,
      };
    }

    const transactionCount = await this.prisma.walletTransaction.count({
      where: { walletId: wallet.id },
    });

    return {
      balance: wallet.balance,
      totalEarned: wallet.totalEarned,
      totalSpent: wallet.totalSpent,
      loyaltyPoints: wallet.loyaltyPoints,
      transactionCount,
    };
  }

  async addLoyaltyPoints(
    tenantId: string,
    clientId: string,
    points: number,
    description?: string,
    referenceType?: string,
    referenceId?: string,
  ) {
    const wallet = await this.getOrCreateWallet(tenantId, clientId);

    // Create wallet transaction for points
    const transaction = await this.prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'credit' as any,
        amount: 0,
        points,
        balanceAfter: wallet.loyaltyPoints + points,
        description: description || 'Loyalty points earned',
        referenceType,
        referenceId,
      },
    });

    // Update wallet points
    const updatedWallet = await this.prisma.clientWallet.update({
      where: { id: wallet.id },
      data: {
        loyaltyPoints: { increment: points },
        totalEarned: { increment: points },
      },
    });

    return { wallet: updatedWallet, transaction };
  }

  async redeemLoyaltyPoints(
    tenantId: string,
    clientId: string,
    points: number,
    description?: string,
    referenceType?: string,
    referenceId?: string,
  ) {
    const wallet = await this.getOrCreateWallet(tenantId, clientId);

    if (wallet.loyaltyPoints < points) {
      throw new Error('Insufficient loyalty points');
    }

    // Create wallet transaction for points redemption
    const transaction = await this.prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'debit' as any,
        amount: 0,
        points,
        balanceAfter: wallet.loyaltyPoints - points,
        description: description || 'Loyalty points redeemed',
        referenceType,
        referenceId,
      },
    });

    // Update wallet points
    const updatedWallet = await this.prisma.clientWallet.update({
      where: { id: wallet.id },
      data: {
        loyaltyPoints: { decrement: points },
        totalSpent: { increment: points },
      },
    });

    return { wallet: updatedWallet, transaction };
  }
}
