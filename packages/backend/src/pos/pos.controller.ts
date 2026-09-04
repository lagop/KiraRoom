import { ParseUUIDPipe, Controller, Get, Post, Body, Param, Query, Req, Patch, Delete } from "@nestjs/common";
import { PosService, CreatePosOrderDto } from './pos.service';
import { ProductService } from './product.service';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

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
  async getDashboard(
    @Req() req: any,
    @Query('date') date?: string,
  ) {
    const tenantId = req.user.tenantId;
    return this.posService.getDashboard(tenantId, date);
  }

  @Get('services')
  @ApiOperation({ summary: 'Get services available for POS' })
  async getServices(@Req() req: any) {
    const tenantId = req.user.tenantId;
    return this.posService.getServices(tenantId);
  }

  @Get('clients')
  @ApiOperation({ summary: 'Get clients for POS' })
  async getClients(
    @Req() req: any,
    @Query('search') search?: string,
  ) {
    const tenantId = req.user.tenantId;
    return this.posService.getClients(tenantId, search);
  }

  @Post('checkout')
  @ApiOperation({ summary: 'Process POS checkout' })
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
  async getOrder(@Param('id', ParseUUIDPipe) id: string) {
    return this.posService.getOrder(id);
  }

  @Get('report/daily')
  @ApiOperation({ summary: 'Get daily sales report' })
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
  async getProducts(
    @Req() req: any,
    @Query('category') category?: string,
    @Query('search') search?: string,
    @Query('lowStock') lowStock?: string,
  ) {
    const tenantId = req.user.tenantId;
    return this.productService.getProducts(tenantId, { category, search, lowStock: lowStock === 'true' });
  }

  @Get('products/:id')
  @ApiOperation({ summary: 'Get a single product' })
  async getProduct(@Param('id', ParseUUIDPipe) id: string) {
    return this.productService.getProduct(id);
  }

  @Post('products')
  @ApiOperation({ summary: 'Create a new product' })
  async createProduct(
    @Req() req: any,
    @Body() body: any,
  ) {
    const tenantId = req.user.tenantId;
    return this.productService.createProduct({ ...body, tenantId });
  }

  @Patch('products/:id')
  @ApiOperation({ summary: 'Update a product' })
  async updateProduct(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: any,
  ) {
    return this.productService.updateProduct(id, body);
  }

  @Delete('products/:id')
  @ApiOperation({ summary: 'Delete a product' })
  async deleteProduct(@Param('id', ParseUUIDPipe) id: string) {
    return this.productService.deleteProduct(id);
  }

  @Get('products/categories')
  @ApiOperation({ summary: 'Get product categories' })
  async getProductCategories(@Req() req: any) {
    const tenantId = req.user.tenantId;
    return this.productService.getCategories(tenantId);
  }

  @Post('products/categories')
  @ApiOperation({ summary: 'Create product category' })
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
  async getOrderDetails(@Param('id', ParseUUIDPipe) id: string) {
    return this.productService.getOrder(id);
  }
}
