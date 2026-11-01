import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { CreateProductDto, UpdateProductDto } from './dto/pos.dto';
import { CLIENT_POS_SELECT } from '../clients/client-select';

export { CreateProductDto, UpdateProductDto };

/**
 * What a product edit may change. The body was untyped, and writing it
 * whole let it reach the salon and its users through the `tenant`
 * relation. It is a validated class now, and the update is still built
 * from this list.
 */
const PRODUCT_FIELDS = [
  "name", "description", "sku", "barcode", "category", "subcategory",
  "price", "costPrice", "currency", "trackInventory", "quantity", "lowStockAlert",
  "imageUrl", "images", "isActive", "isFeatured", "taxRate", "showOnline",
  "onlinePrice", "earnPoints", "pointsEarned",
] as const satisfies ReadonlyArray<keyof UpdateProductDto>;

/** Columns that may be cleared; for the rest a `null` means "unchanged". */
const NULLABLE_PRODUCT_FIELDS: ReadonlySet<string> = new Set([
  "description", "sku", "barcode", "category", "subcategory",
  "costPrice", "imageUrl", "taxRate", "onlinePrice",
]);

export interface InventoryAdjustmentDto {
  productId: string;
  tenantId: string;
  type: 'restock' | 'adjustment' | 'transfer' | 'damaged' | 'expired';
  quantity: number;
  reason?: string;
  notes?: string;
}

/**
 * The salon's products and their stock. Products are SOLD at the till
 * (PosService.processCheckout: priced with tax, stock taken in the sale's
 * transaction). The old order flow here (createOrder: prices in float
 * euros, "Stripe payment would be handled here", stock taken outside any
 * transaction) and its unused stats were removed: nothing called them.
 */
@Injectable()
export class ProductService {
  constructor(private readonly prisma: PrismaService) {}

  // ============================================
  // PRODUCT CRUD
  // ============================================

  async createProduct(tenantId: string, dto: CreateProductDto) {
    return this.prisma.product.create({
      data: {
        tenantId,
        name: dto.name,
        description: dto.description,
        sku: dto.sku,
        barcode: dto.barcode,
        category: dto.category,
        subcategory: dto.subcategory,
        price: dto.price,
        costPrice: dto.costPrice,
        currency: dto.currency || 'EUR',
        trackInventory: dto.trackInventory ?? true,
        quantity: dto.quantity ?? 0,
        lowStockAlert: dto.lowStockAlert ?? 5,
        imageUrl: dto.imageUrl,
        images: dto.images || [],
        isActive: dto.isActive ?? true,
        isFeatured: dto.isFeatured ?? false,
        taxRate: dto.taxRate,
        showOnline: dto.showOnline ?? false,
        onlinePrice: dto.onlinePrice,
        earnPoints: dto.earnPoints ?? false,
        pointsEarned: dto.pointsEarned ?? 0,
      },
    });
  }

  async getProducts(tenantId: string, params?: {
    category?: string;
    isActive?: boolean;
    search?: string;
    lowStock?: boolean;
  }) {
    const where: any = { tenantId };

    if (params?.category) {
      where.category = params.category;
    }
    if (params?.isActive !== undefined) {
      where.isActive = params.isActive;
    }
    if (params?.search) {
      where.OR = [
        { name: { contains: params.search, mode: 'insensitive' } },
        { description: { contains: params.search, mode: 'insensitive' } },
        { sku: { contains: params.search, mode: 'insensitive' } },
      ];
    }
    if (params?.lowStock) {
      where.AND = [
        { trackInventory: true },
        { quantity: { lte: 5 } },
      ];
    }

    return this.prisma.product.findMany({
      where,
      orderBy: { name: 'asc' },
    });
  }

  /** One of this salon's products (404 for any other id). */
  async getProduct(tenantId: string, id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, tenantId },
    });
    if (!product) {
      throw new NotFoundException('Producto no encontrado');
    }
    return product;
  }

  /**
   * Edits a product. A new `quantity` is a stock count: it goes through the
   * inventory log as an adjustment (the difference), like POST
   * /pos/inventory/adjust, instead of overwriting the stock with no trace.
   */
  async updateProduct(tenantId: string, id: string, dto: UpdateProductDto) {
    const product = await this.getProduct(tenantId, id);

    const data: Record<string, unknown> = {};
    for (const key of PRODUCT_FIELDS) {
      if (key === 'quantity') continue;
      const value = dto?.[key];
      if (value === undefined || (value === null && !NULLABLE_PRODUCT_FIELDS.has(key))) continue;
      data[key] = value;
    }
    if (typeof dto?.quantity === 'number' && dto.quantity !== product.quantity) {
      await this.adjustInventory({
        tenantId,
        productId: id,
        type: 'adjustment',
        quantity: dto.quantity,
        reason: 'Recuento al editar el producto',
      });
    }
    if (Object.keys(data).length === 0) return this.getProduct(tenantId, id);
    return this.prisma.product.update({
      where: { id: product.id },
      data,
    });
  }

  /**
   * Deletes a product with no history. One that was sold or had its stock
   * moved is deactivated instead (it leaves the till and the shop, its
   * history stays): deleting it cascaded its inventory log away.
   */
  async deleteProduct(tenantId: string, id: string) {
    const product = await this.getProduct(tenantId, id);
    const [movements, orders] = await Promise.all([
      this.prisma.inventoryTransaction.count({ where: { productId: id, tenantId } }),
      this.prisma.productOrder.count({ where: { productId: id } }),
    ]);
    if (movements > 0 || orders > 0) {
      const updated = await this.prisma.product.update({ where: { id: product.id }, data: { isActive: false } });
      return { ...updated, deactivated: true };
    }
    try {
      await this.prisma.product.delete({ where: { id: product.id } });
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2003') {
        throw new ConflictException('Este producto tiene historial: desactívalo en lugar de borrarlo.');
      }
      throw err;
    }
    return { ...product, deleted: true };
  }

  // ============================================
  // PRODUCT CATEGORIES
  // ============================================

  async getCategories(tenantId: string) {
    return this.prisma.productCategory.findMany({
      where: { tenantId, isActive: true },
      orderBy: { displayOrder: 'asc' },
      include: {
        children: true,
      },
    });
  }

  async createCategory(tenantId: string, data: {
    name: string;
    description?: string;
    parentId?: string;
    imageUrl?: string;
    displayOrder?: number;
  }) {
    if (data.parentId) {
      const parent = await this.prisma.productCategory.findFirst({
        where: { id: data.parentId, tenantId },
        select: { id: true },
      });
      if (!parent) throw new NotFoundException('Categoría no encontrada');
    }
    return this.prisma.productCategory.create({
      data: {
        tenantId,
        name: data.name,
        description: data.description,
        parentId: data.parentId,
        imageUrl: data.imageUrl,
        displayOrder: data.displayOrder ?? 0,
      },
    });
  }

  // ============================================
  // INVENTORY MANAGEMENT
  // ============================================

  /**
   * A stock movement, logged. `restock` adds units; `transfer`, `damaged`
   * and `expired` take them out; `adjustment` sets the counted stock and
   * logs the DIFFERENCE (it logged minus the new stock: a count of 12 on
   * 10 units was "-12"). The stock is written over the value just read, so
   * a sale at the till meanwhile is never overwritten (409, try again).
   */
  async adjustInventory(dto: InventoryAdjustmentDto) {
    const product = await this.getProduct(dto.tenantId, dto.productId);

    const previousQty = product.quantity;
    let newQty: number;
    switch (dto.type) {
      case 'restock':
        newQty = previousQty + dto.quantity;
        break;
      case 'adjustment':
        newQty = dto.quantity;
        break;
      default:
        // transfer, damaged, expired
        newQty = previousQty - dto.quantity;
        break;
    }

    if (newQty < 0) {
      throw new BadRequestException(`No hay tantas unidades de ${product.name}: quedan ${previousQty}.`);
    }

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.product.updateMany({
        where: { id: product.id, tenantId: dto.tenantId, quantity: previousQty },
        data: { quantity: newQty },
      });
      if (count !== 1) {
        throw new ConflictException('El stock de este producto acaba de cambiar (una venta). Recarga y vuelve a intentarlo.');
      }
      await tx.inventoryTransaction.create({
        data: {
          productId: product.id,
          tenantId: dto.tenantId,
          type: dto.type,
          // Signed: what came in (+) or went out (-).
          quantity: newQty - previousQty,
          previousQty,
          newQty,
          reason: dto.reason,
          notes: dto.notes,
        },
      });
      return tx.product.findFirst({ where: { id: product.id, tenantId: dto.tenantId } });
    });
  }

  async getInventoryTransactions(tenantId: string, productId?: string) {
    return this.prisma.inventoryTransaction.findMany({
      where: {
        tenantId,
        productId,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // ============================================
  // ORDERS (legacy, read only)
  // ============================================

  async getOrders(tenantId: string, params?: {
    status?: string;
    clientId?: string;
    startDate?: string;
    endDate?: string;
  }) {
    const where: any = { tenantId };

    if (params?.status) {
      where.status = params.status;
    }
    if (params?.clientId) {
      where.clientId = params.clientId;
    }
    if (params?.startDate || params?.endDate) {
      where.createdAt = {};
      if (params?.startDate) {
        where.createdAt.gte = new Date(params.startDate);
      }
      if (params?.endDate) {
        where.createdAt.lte = new Date(params.endDate);
      }
    }

    return this.prisma.order.findMany({
      where,
      include: {
        client: { select: CLIENT_POS_SELECT },
        items: {
          include: {
            product: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** One of this salon's orders (404 for any other id). */
  async getOrder(tenantId: string, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId },
      include: {
        client: { select: CLIENT_POS_SELECT },
        items: {
          include: {
            product: true,
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Pedido no encontrado');
    return order;
  }
}
