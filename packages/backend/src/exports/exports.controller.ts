import { Controller, Get, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { ExportsService, ExportEntity } from "./exports.service";
import { Roles, SALON_MANAGERS } from "../auth/decorators/roles.decorator";
import { PaymentFiltersDto } from "../payments/payments-query";

@ApiTags("exports")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("exports")
export class ExportsController {
  constructor(private readonly service: ExportsService) {}

  private handle(
    entity: ExportEntity,
    format: "csv" | "xlsx",
    req: any,
    res: Response,
    filters?: PaymentFiltersDto,
  ) {
    return this.service.stream(req.user.tenantId, entity, format, res, filters);
  }

  /** The Pagos page's filters: status, method, client, dates (payments-query.ts). */
  private paymentFilters(q: PaymentFiltersDto) {
    return { status: q.status, method: q.method, clientId: q.clientId, dateFrom: q.dateFrom, dateTo: q.dateTo } as PaymentFiltersDto;
  }

  @Get("clients.csv")
  @Roles(...SALON_MANAGERS)
  clientsCsv(@Req() req: any, @Res() res: Response) {
    return this.handle("clients", "csv", req, res);
  }
  @Get("clients.xlsx")
  @Roles(...SALON_MANAGERS)
  clientsXlsx(@Req() req: any, @Res() res: Response) {
    return this.handle("clients", "xlsx", req, res);
  }

  @Get("appointments.csv")
  @Roles(...SALON_MANAGERS)
  appointmentsCsv(@Req() req: any, @Res() res: Response) {
    return this.handle("appointments", "csv", req, res);
  }
  @Get("appointments.xlsx")
  @Roles(...SALON_MANAGERS)
  appointmentsXlsx(@Req() req: any, @Res() res: Response) {
    return this.handle("appointments", "xlsx", req, res);
  }

  @Get("payments.csv")
  @Roles(...SALON_MANAGERS)
  paymentsCsv(@Req() req: any, @Res() res: Response, @Query() q: PaymentFiltersDto) {
    return this.handle("payments", "csv", req, res, this.paymentFilters(q));
  }
  @Get("payments.xlsx")
  @Roles(...SALON_MANAGERS)
  paymentsXlsx(@Req() req: any, @Res() res: Response, @Query() q: PaymentFiltersDto) {
    return this.handle("payments", "xlsx", req, res, this.paymentFilters(q));
  }

  @Get("services.csv")
  @Roles(...SALON_MANAGERS)
  servicesCsv(@Req() req: any, @Res() res: Response) {
    return this.handle("services", "csv", req, res);
  }
  @Get("services.xlsx")
  @Roles(...SALON_MANAGERS)
  servicesXlsx(@Req() req: any, @Res() res: Response) {
    return this.handle("services", "xlsx", req, res);
  }

  @Get("professionals.csv")
  @Roles(...SALON_MANAGERS)
  professionalsCsv(@Req() req: any, @Res() res: Response) {
    return this.handle("professionals", "csv", req, res);
  }
  @Get("professionals.xlsx")
  @Roles(...SALON_MANAGERS)
  professionalsXlsx(@Req() req: any, @Res() res: Response) {
    return this.handle("professionals", "xlsx", req, res);
  }

  @Get("wallet-transactions.csv")
  @Roles(...SALON_MANAGERS)
  walletTxCsv(@Req() req: any, @Res() res: Response) {
    return this.handle("wallet-transactions", "csv", req, res);
  }
  @Get("wallet-transactions.xlsx")
  @Roles(...SALON_MANAGERS)
  walletTxXlsx(@Req() req: any, @Res() res: Response) {
    return this.handle("wallet-transactions", "xlsx", req, res);
  }

  @Get("gift-cards.csv")
  @Roles(...SALON_MANAGERS)
  giftCardsCsv(@Req() req: any, @Res() res: Response) {
    return this.handle("gift-cards", "csv", req, res);
  }
  @Get("gift-cards.xlsx")
  @Roles(...SALON_MANAGERS)
  giftCardsXlsx(@Req() req: any, @Res() res: Response) {
    return this.handle("gift-cards", "xlsx", req, res);
  }
}
