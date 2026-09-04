import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { StripeService } from '../payments/services/stripe.service';
import { WalletService } from '../payments/services/wallet.service';

export interface CreateProductDto {
  tenantId: string;
  name: string;
  description?: string;
  sku?: string;
  barcode?: string;
  category?: string;
  subcategory?: string;
  price: number;
  costPrice?: number;
  currency?: string;
  trackInventory?: boolean;
  quantity?: number;
  lowStockAlert?: number;
  imageUrl?: string;
  images?: string[];
  isActive?: boolean;
  isFeatured?: boolean;
  taxRate?: number;
  showOnline?: boolean;
  onlinePrice?: number;
  earnPoints?: boolean;
  pointsEarned?: number;
}

export interface UpdateProductDto {
  name?: string;
  description?: string;
  sku?: string;
  barcode?: string;
  category?: string;
  subcategory?: string;
  price?: number;
  costPrice?: number;
  currency?: string;
  trackInventory?: boolean;
  quantity?: number;
  lowStockAlert?: number;
  imageUrl?: string;
  images?: string[];
  isActive?: boolean;
  isFeatured?: boolean;
  taxRate?: number;
  showOnline?: boolean;
  onlinePrice?: number;
  earnPoints?: boolean;
  pointsEarned?: number;
}

export interface CreateOrderDto {
  tenantId: string;
  clientId?: string;
  items: {
    productId: string;
    quantity: number;
    unitPrice: number;
  }[];
  paymentMethod: 'card' | 'cash' | 'bank_transfer' | 'wallet' | 'gift_card';
  notes?: string;
  source?: string;
}

export interface InventoryAdjustmentDto {
  productId: string;
  tenantId: string;
  type: 'restock' | 'adjustment' | 'transfer' | 'damaged' | 'expired';
  quantity: number;
  reason?: string;
  notes?: string;
}

@Injectable()
export class ProductService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly walletService: WalletService,
  ) {}

  // ============================================
  // PRODUCT CRUD
  // ============================================

  async createProduct(dto: CreateProductDto) {
    return this.prisma.product.create({
      data: {
        tenantId: dto.tenantId,
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

  async getProduct(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        tenant: true,
      },
    });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  async updateProduct(id: string, dto: UpdateProductDto) {
    await this.getProduct(id); // Verify exists

    return this.prisma.product.update({
      where: { id },
      data: dto,
    });
  }

  async deleteProduct(id: string) {
    await this.getProduct(id);

    return this.prisma.product.delete({
      where: { id },
    });
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

  async adjustInventory(dto: InventoryAdjustmentDto) {
    const product = await this.getProduct(dto.productId);
    if (product.tenantId !== dto.tenantId) {
      throw new BadRequestException('Product does not belong to tenant');
    }

    const previousQty = product.quantity;
    let newQty = dto.quantity;

    // Calculate new quantity based on type
    switch (dto.type) {
      case 'restock':
        newQty = previousQty + dto.quantity;
        break;
      case 'adjustment':
        newQty = dto.quantity;
        break;
      case 'transfer':
        newQty = previousQty - dto.quantity;
        break;
      case 'damaged':
      case 'expired':
        newQty = previousQty - dto.quantity;
        break;
    }

    if (newQty < 0) {
      throw new BadRequestException('Insufficient inventory');
    }

    // Update product quantity
    const updatedProduct = await this.prisma.product.update({
      where: { id: dto.productId },
      data: { quantity: newQty },
    });

    // Create inventory transaction
    await this.prisma.inventoryTransaction.create({
      data: {
        productId: dto.productId,
        tenantId: dto.tenantId,
        type: dto.type,
        quantity: dto.type === 'restock' ? dto.quantity : -Math.abs(dto.quantity),
        previousQty,
        newQty,
        reason: dto.reason,
        notes: dto.notes,
      },
    });

    return updatedProduct;
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

  async getLowStockProducts(tenantId: string) {
    return this.prisma.product.findMany({
      where: {
        tenantId,
        trackInventory: true,
        quantity: { lte: 5 },
        isActive: true,
      },
      orderBy: { quantity: 'asc' },
    });
  }

  // ============================================
  // ORDERS (POS SALES)
  // ============================================

  async createOrder(dto: CreateOrderDto) {
    // Validate products and calculate totals
    let subtotal = 0;
    const orderItems = [];

    for (const item of dto.items) {
      const product = await this.getProduct(item.productId);
      
      if (product.tenantId !== dto.tenantId) {
        throw new BadRequestException(`Product ${product.name} does not belong to tenant`);
      }

      if (!product.isActive) {
        throw new BadRequestException(`Product ${product.name} is not available`);
      }

      // Check inventory
      if (product.trackInventory && product.quantity < item.quantity) {
        throw new BadRequestException(`Insufficient inventory for ${product.name}`);
      }

      const itemTotal = item.unitPrice * item.quantity;
      subtotal += itemTotal;

      orderItems.push({
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: itemTotal,
      });

      // Deduct inventory
      if (product.trackInventory) {
        await this.adjustInventory({
          productId: item.productId,
          tenantId: dto.tenantId,
          type: 'sale' as any,
          quantity: item.quantity,
          reason: 'POS Sale',
        });
      }
    }

    // Generate order number
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0].replace(/-/g, '');
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    const orderNumber = `ORD-${dateStr}-${random}`;

    // Calculate loyalty points
    const pointsEarned = Math.floor(subtotal); // 1 point per euro

    // Create order
    const order = await this.prisma.order.create({
      data: {
        tenantId: dto.tenantId,
        clientId: dto.clientId,
        orderNumber,
        status: 'completed',
        type: 'sale',
        subtotal,
        taxAmount: 0,
        discount: 0,
        total: subtotal,
        paidAmount: subtotal,
        paymentMethod: dto.paymentMethod,
        pointsEarned,
        source: dto.source || 'pos',
        notes: dto.notes,
        items: {
          create: orderItems,
        },
      },
      include: {
        items: {
          include: {
            product: true,
          },
        },
        client: true,
      },
    });

    // Process payment
    if (dto.paymentMethod === 'card') {
      // Stripe payment would be handled here
    } else if (dto.paymentMethod === 'wallet' && dto.clientId) {
      await this.walletService.deductFunds(dto.tenantId, dto.clientId, Number(subtotal), 'Order payment');
    }

    return order;
  }

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
        client: true,
        items: {
          include: {
            product: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getOrder(id: string) {
    return this.prisma.order.findUnique({
      where: { id },
      include: {
        client: true,
        items: {
          include: {
            product: true,
          },
        },
      },
    });
  }

  // ============================================
  // DASHBOARD / ANALYTICS
  // ============================================

  async getProductStats(tenantId: string) {
    const [
      totalProducts,
      activeProducts,
      lowStockProducts,
      outOfStock,
      totalInventoryValue,
    ] = await Promise.all([
      this.prisma.product.count({ where: { tenantId } }),
      this.prisma.product.count({ where: { tenantId, isActive: true } }),
      this.prisma.product.count({ 
        where: { tenantId, trackInventory: true, quantity: { lte: 5, gt: 0 } } 
      }),
      this.prisma.product.count({ 
        where: { tenantId, trackInventory: true, quantity: { lte: 0 } } 
      }),
      this.prisma.product.aggregate({
        where: { tenantId, trackInventory: true },
        _sum: {
          quantity: true,
        },
      }),
    ]);

    // Calculate total inventory value (price * quantity)
    const products = await this.prisma.product.findMany({
      where: { tenantId, trackInventory: true },
      select: { price: true, quantity: true },
    });

    const inventoryValue = products.reduce(
      (sum, p) => sum + Number(p.price || 0) * (p.quantity || 0),
      0
    );

    return {
      totalProducts,
      activeProducts,
      lowStockProducts,
      outOfStock,
      totalInventoryUnits: totalInventoryValue._sum.quantity || 0,
      inventoryValue,
    };
  }

  async getSalesStats(tenantId: string, period?: 'day' | 'week' | 'month') {
    const now = new Date();
    let startDate: Date;

    switch (period) {
      case 'day':
        startDate = new Date(now.setHours(0, 0, 0, 0));
        break;
      case 'week':
        startDate = new Date(now.setDate(now.getDate() - 7));
        break;
      case 'month':
      default:
        startDate = new Date(now.setMonth(now.getMonth() - 1));
        break;
    }

    const orders = await this.prisma.order.findMany({
      where: {
        tenantId,
        createdAt: { gte: startDate },
        status: 'completed',
      },
      include: {
        items: true,
      },
    });

    const totalSales = orders.reduce((sum, o) => sum + Number(o.total || 0), 0);
    const totalOrders = orders.length;
    const averageOrderValue = totalOrders > 0 ? totalSales / totalOrders : 0;
    const totalItems = orders.reduce((sum, o) => sum + o.items.length, 0);

    return {
      period,
      totalSales,
      totalOrders,
      averageOrderValue,
      totalItems,
    };
  }
}
