import { ParseUUIDPipe, Controller, Get, Post, Body, Param, Query, Req, Patch, Delete } from "@nestjs/common";
import { PosService, CreatePosOrderDto } from './pos.service';
import { ProductService } from './product.service';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles, SALON_TEAM, SALON_MANAGERS } from "../auth/decorators/roles.decorator";

@ApiTags('POS')
@ApiBearerAuth()
@Controller('pos')
export class PosController {
  constructor(
    private readonly posService: PosService,
    private readonly productService: ProductService,
  ) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Get POS dashboard data' })
  @Roles(...SALON_TEAM)
  async getDashboard(
    @Req() req: any,
    @Query('date') date?: string,
  ) {
    const tenantId = req.user.tenantId;
    return this.posService.getDashboard(tenantId, date);
  }

  @Get('services')
  @ApiOperation({ summary: 'Get services available for POS' })
  @Roles(...SALON_TEAM)
  async getServices(@Req() req: any) {
    const tenantId = req.user.tenantId;
    return this.posService.getServices(tenantId);
  }

  @Get('clients')
  @ApiOperation({ summary: 'Get clients for POS' })
  @Roles(...SALON_TEAM)
  async getClients(
    @Req() req: any,
    @Query('search') search?: string,
  ) {
    const tenantId = req.user.tenantId;
    return this.posService.getClients(tenantId, search);
  }

  @Post('checkout')
  @ApiOperation({ summary: 'Process POS checkout' })
  @Roles(...SALON_TEAM)
  async checkout(
    @Req() req: any,
    @Body() dto: CreatePosOrderDto,
  ) {
    // Override tenantId from JWT token for security
    const checkoutData = { ...dto, tenantId: req.user.tenantId };
    return this.posService.processCheckout(checkoutData);
  }

  @Post('quick-sale')
  @ApiOperation({ summary: 'Process a quick sale' })
  @Roles(...SALON_TEAM)
  async quickSale(
    @Req() req: any,
    @Body() body: { serviceId: string; paymentMethod: 'cash' | 'card'; clientId?: string },
  ) {
    const tenantId = req.user.tenantId;
    return this.posService.quickSale(
      tenantId,
      body.serviceId,
      body.paymentMethod,
      body.clientId,
    );
  }

  @Get('order/:id')
  @ApiOperation({ summary: 'Get order/receipt details' })
  @Roles(...SALON_TEAM)
  async getOrder(@Param('id', ParseUUIDPipe) id: string) {
    return this.posService.getOrder(id);
  }

  @Get('report/daily')
  @ApiOperation({ summary: 'Get daily sales report' })
  @Roles(...SALON_TEAM)
  async getDailyReport(
    @Req() req: any,
    @Query('date') date: string,
  ) {
    const tenantId = req.user.tenantId;
    return this.posService.getDailyReport(tenantId, date);
  }

  // ============ PRODUCTS ============

  @Get('products')
  @ApiOperation({ summary: 'Get all products' })
  @Roles(...SALON_TEAM)
  async getProducts(
    @Req() req: any,
    @Query('category') category?: string,
    @Query('search') search?: string,
    @Query('lowStock') lowStock?: string,
  ) {
    const tenantId = req.user.tenantId;
    return this.productService.getProducts(tenantId, { category, search, lowStock: lowStock === 'true' });
  }

  // Before 'products/:id': declared after it, 'categories' matched ':id'
  // first and ParseUUIDPipe answered 400.
  @Get('products/categories')
  @ApiOperation({ summary: 'Get product categories' })
  @Roles(...SALON_TEAM)
  async getProductCategories(@Req() req: any) {
    const tenantId = req.user.tenantId;
    return this.productService.getCategories(tenantId);
  }

  @Get('products/:id')
  @ApiOperation({ summary: 'Get a single product' })
  @Roles(...SALON_TEAM)
  async getProduct(@Param('id', ParseUUIDPipe) id: string) {
    return this.productService.getProduct(id);
  }

  @Post('products')
  @ApiOperation({ summary: 'Create a new product' })
  @Roles(...SALON_MANAGERS)
  async createProduct(
    @Req() req: any,
    @Body() body: any,
  ) {
    const tenantId = req.user.tenantId;
    return this.productService.createProduct({ ...body, tenantId });
  }

  @Patch('products/:id')
  @ApiOperation({ summary: 'Update a product' })
  @Roles(...SALON_MANAGERS)
  async updateProduct(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: any,
  ) {
    return this.productService.updateProduct(id, body);
  }

  @Delete('products/:id')
  @ApiOperation({ summary: 'Delete a product' })
  @Roles(...SALON_MANAGERS)
  async deleteProduct(@Param('id', ParseUUIDPipe) id: string) {
    return this.productService.deleteProduct(id);
  }

  @Post('products/categories')
  @ApiOperation({ summary: 'Create product category' })
  @Roles(...SALON_MANAGERS)
  async createProductCategory(
    @Req() req: any,
    @Body() body: { name: string; description?: string },
  ) {
    const tenantId = req.user.tenantId;
    return this.productService.createCategory(tenantId, body);
  }

  // ============ INVENTORY ============

  @Get('inventory')
  @ApiOperation({ summary: 'Get inventory transactions' })
  @Roles(...SALON_TEAM)
  async getInventoryTransactions(
    @Req() req: any,
    @Query('productId') productId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const tenantId = req.user.tenantId;
    return this.productService.getInventoryTransactions(tenantId, productId);
  }

  @Post('inventory/adjust')
  @ApiOperation({ summary: 'Adjust inventory' })
  @Roles(...SALON_MANAGERS)
  async adjustInventory(
    @Req() req: any,
    @Body() body: { productId: string; type: 'restock' | 'adjustment' | 'transfer' | 'damaged' | 'expired'; quantity: number; reason?: string },
  ) {
    const tenantId = req.user.tenantId;
    return this.productService.adjustInventory({ tenantId, ...body });
  }

  // ============ ORDERS ============

  @Get('orders')
  @ApiOperation({ summary: 'Get orders' })
  @Roles(...SALON_TEAM)
  async getOrders(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('clientId') clientId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const tenantId = req.user.tenantId;
    return this.productService.getOrders(tenantId, { status, clientId, startDate, endDate });
  }

  @Get('orders/:id')
  @ApiOperation({ summary: 'Get order details' })
  @Roles(...SALON_TEAM)
  async getOrderDetails(@Param('id', ParseUUIDPipe) id: string) {
    return this.productService.getOrder(id);
  }
}
