import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

/** The part of Prisma a wallet movement needs: the service or a transaction. */
type WalletDb = Pick<Prisma.TransactionClient, 'clientWallet' | 'walletTransaction'>;

const euros = (cents: number) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100);

@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 404 unless the client is one of this salon's. The wallet routes took any
   * id: another salon's client got a wallet in this salon, readable and
   * chargeable from here.
   */
  async assertClientOfSalon(tenantId: string, clientId: string): Promise<void> {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId }, select: { id: true } });
    if (!client) throw new NotFoundException('Clienta no encontrada');
  }

  // ============ WALLET OPERATIONS ============

  /**
   * The client's wallet, created empty the first time. An upsert on the
   * unique client: two first movements at once no longer race to create it.
   */
  private async walletIn(db: WalletDb, tenantId: string, clientId: string) {
    const wallet = await db.clientWallet.upsert({
      where: { clientId },
      create: { tenantId, clientId, balance: 0, totalEarned: 0, totalSpent: 0, loyaltyPoints: 0 },
      update: {},
    });
    if (wallet.tenantId !== tenantId) throw new NotFoundException('Clienta no encontrada');
    return wallet;
  }

  async getOrCreateWallet(tenantId: string, clientId: string) {
    return this.walletIn(this.prisma, tenantId, clientId);
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
      throw new NotFoundException('Esta clienta todavía no tiene cartera');
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
      throw new NotFoundException('Cartera no encontrada');
    }

    return wallet;
  }

  /**
   * Money into the wallet, inside the caller's transaction (a refund paid
   * back to the wallet commits with the refund). The balance after is read
   * from the row just written, not worked out from a balance read before.
   */
  async creditIn(
    db: WalletDb,
    tenantId: string,
    clientId: string,
    amount: number,
    description?: string,
    referenceType?: string,
    referenceId?: string,
  ) {
    const wallet = await this.walletIn(db, tenantId, clientId);
    const updated = await db.clientWallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: amount } },
    });
    const transaction = await db.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'credit',
        amount,
        balanceAfter: updated.balance,
        description: description || 'Ingreso',
        referenceType,
        referenceId,
      },
    });
    return { wallet: updated, transaction };
  }

  async addFunds(
    tenantId: string,
    clientId: string,
    amount: number,
    description?: string,
    referenceType?: string,
    referenceId?: string,
  ) {
    return this.prisma.$transaction((tx) =>
      this.creditIn(tx, tenantId, clientId, amount, description, referenceType, referenceId),
    );
  }

  /**
   * Money out of the wallet. The balance is checked by the write itself
   * (`balance >= amount`): it was read, compared and then decremented, so
   * two charges at once on 10 € could take 8 € each and leave -6 €.
   */
  async deductFunds(
    tenantId: string,
    clientId: string,
    amount: number,
    description?: string,
    referenceType?: string,
    referenceId?: string,
  ) {
    return this.prisma.$transaction((tx) =>
      this.debitIn(tx, tenantId, clientId, amount, description, referenceType, referenceId),
    );
  }

  /**
   * Money out of the wallet inside the caller's transaction: a till sale
   * paid with the wallet commits, or rolls back, with the sale.
   */
  async debitIn(
    tx: WalletDb,
    tenantId: string,
    clientId: string,
    amount: number,
    description?: string,
    referenceType?: string,
    referenceId?: string,
  ) {
    {
      const wallet = await this.walletIn(tx, tenantId, clientId);
      const { count } = await tx.clientWallet.updateMany({
        where: { id: wallet.id, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      if (count !== 1) {
        const current = await tx.clientWallet.findUnique({ where: { id: wallet.id }, select: { balance: true } });
        throw new BadRequestException(
          `Saldo insuficiente en la cartera: tiene ${euros(current?.balance ?? 0)} y se intentan cobrar ${euros(amount)}.`,
        );
      }
      const updated = await tx.clientWallet.findUniqueOrThrow({ where: { id: wallet.id } });
      const transaction = await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'debit',
          amount,
          balanceAfter: updated.balance,
          description: description || 'Cobro',
          referenceType,
          referenceId,
        },
      });
      return { wallet: updated, transaction };
    }
  }


  async getTransactions(tenantId: string, walletId: string, limit = 20) {
    const wallet = await this.prisma.clientWallet.findFirst({
      where: { id: walletId, tenantId },
    });

    if (!wallet) {
      throw new NotFoundException('Cartera no encontrada');
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
      transactionCount,
    };
  }

  // addLoyaltyPoints / redeemLoyaltyPoints moved ClientWallet.loyaltyPoints
  // (and added points to totalEarned/totalSpent, which are euros). Loyalty
  // is the LoyaltyTransaction ledger since #120 (LoyaltyService); the column
  // stays in the schema but nothing writes or shows it any more.
}
