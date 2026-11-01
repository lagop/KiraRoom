import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma, type UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditLogService } from '../../saas/audit-log.service';
import { drawerClosed, openCashSessionId } from '../../pos/cash-session-lock';
import type { WalletTopUpMethod } from '../dto/payment-bodies.dto';

/** The part of Prisma a wallet movement needs: the service or a transaction. */
type WalletDb = Pick<Prisma.TransactionClient, 'clientWallet' | 'walletTransaction'>;

const euros = (cents: number) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100);

/** What a top-up says in the wallet history when it has no note. */
const TOP_UP_LABEL: Record<WalletTopUpMethod, string> = {
  cash: 'Recarga en efectivo',
  card: 'Recarga con tarjeta',
  bizum: 'Recarga por Bizum',
  bank_transfer: 'Recarga por transferencia',
};

/** How a top-up was paid, kept on its wallet movement. */
export interface WalletTender {
  method: WalletTopUpMethod;
  cashSessionId: string | null;
  recordedById: string;
}

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    // A top-up is audit-logged; optional so the tests can build the service bare.
    @Optional() private readonly auditLog?: AuditLogService,
  ) {}

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
    tender?: WalletTender,
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
        ...(tender ? { method: tender.method, cashSessionId: tender.cashSessionId, recordedById: tender.recordedById } : {}),
      },
    });
    return { wallet: updated, transaction };
  }

  /**
   * A top-up: money the client hands over to load her wallet, and how she
   * paid it.
   *
   * - The tender is kept on the wallet movement, not as a Payment: the money
   *   is a prepayment (the salon owes it in services), so it is not revenue
   *   now. Revenue is recognised when the wallet is spent, as a wallet
   *   payment at the till, and counting it here too would count it twice
   *   (Pagos, client totals, analytics).
   * - Cash goes into the drawer: it needs one open (409 CASH_SESSION_CLOSED,
   *   like a cash sale) and counts in its expected cash. Card, Bizum and
   *   transfer are linked to the open drawer, if any, and appear in its
   *   report by method. The session row is held FOR SHARE until this
   *   commits, so the drawer cannot close under it (cash-session-lock.ts).
   */
  async topUp(
    tenantId: string,
    clientId: string,
    amount: number,
    method: WalletTopUpMethod,
    actor: { id: string; role: string },
    description?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const cashSessionId = await openCashSessionId(tx, tenantId, 'share');
      if (method === 'cash' && !cashSessionId) throw drawerClosed();
      const out = await this.creditIn(
        tx,
        tenantId,
        clientId,
        amount,
        description?.trim() || TOP_UP_LABEL[method],
        'top_up',
        undefined,
        { method, cashSessionId, recordedById: actor.id },
      );
      await this.auditLog?.record(
        'payments.wallet.top_up',
        {
          actorId: actor.id,
          actorRole: actor.role as UserRole,
          tenantId,
          metadata: { clientId, amount, method, cashSessionId, walletTransactionId: out.transaction.id },
        },
        tx,
      );
      return out;
    });
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
