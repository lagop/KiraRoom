import { Controller, Get, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiQuery, ApiTags } from "@nestjs/swagger";
import { IsOptional, IsString, Matches } from "class-validator";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { ExportsService, ExportEntity } from "./exports.service";
import { Roles, SALON_MANAGERS } from "../auth/decorators/roles.decorator";
import { PaymentFiltersDto } from "../payments/payments-query";
import { AnalyticsService } from "../analytics/analytics.service";
import { AnalyticsFlagsService } from "../analytics/analytics-flags.service";
import { LocationScope, requestedLocationScope } from "../analytics/analytics-location";

const LOCATION_DESCRIPTION =
  "Empresa: only this location (appointments booked there, or with none and a professional who works there; payments of those appointments). 400 malformed, 403 on other plans, 404 for another salon's location.";

/** The appointments export's optional range: salon calendar days, both inclusive. */
export class AppointmentsExportQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "La fecha no es válida: usa el formato AAAA-MM-DD." })
  dateFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "La fecha no es válida: usa el formato AAAA-MM-DD." })
  dateTo?: string;

  /** Empresa: one location only (analytics-location.ts), checked by requestedLocationScope. */
  @IsOptional()
  @IsString({ message: "El local no es válido." })
  locationId?: string;
}

/** The payments export: the Pagos page's filters and, on Empresa, one location. */
export class PaymentsExportQueryDto extends PaymentFiltersDto {
  @IsOptional()
  @IsString({ message: "El local no es válido." })
  locationId?: string;
}

@ApiTags("exports")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("exports")
export class ExportsController {
  constructor(
    private readonly service: ExportsService,
    private readonly analytics: AnalyticsService,
    private readonly analyticsFlags: AnalyticsFlagsService,
  ) {}

  private handle(
    entity: ExportEntity,
    format: "csv" | "xlsx",
    req: any,
    res: Response,
    filters?: PaymentFiltersDto,
    scope?: LocationScope,
  ) {
    return this.service.stream(req.user.tenantId, entity, format, res, filters, scope);
  }

  /**
   * Empresa: the appointments and payments of one location, by Analítica's
   * rules and gate (consolidated_reports). 400 malformed, 403 on another plan,
   * 404 for a location that is not this salon's: checked before the file starts.
   */
  private scope(req: any, locationId: string | undefined): Promise<LocationScope | undefined> {
    return requestedLocationScope(
      req.user.tenantId,
      locationId,
      {
        hasLocationFilter: (t) => this.analyticsFlags.hasLocationFilter(t),
        locationScope: (t, id) => this.analytics.locationScope(t, id),
      },
      "Exportar por local está disponible en el plan Empresa.",
    );
  }

  private async appointments(format: "csv" | "xlsx", req: any, res: Response, q: AppointmentsExportQueryDto) {
    const scope = await this.scope(req, q.locationId);
    return this.handle("appointments", format, req, res, { dateFrom: q.dateFrom, dateTo: q.dateTo }, scope);
  }

  private async payments(format: "csv" | "xlsx", req: any, res: Response, q: PaymentsExportQueryDto) {
    const scope = await this.scope(req, q.locationId);
    return this.handle("payments", format, req, res, this.paymentFilters(q), scope);
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
  @ApiQuery({ name: "dateFrom", required: false, description: "First salon day (YYYY-MM-DD), inclusive" })
  @ApiQuery({ name: "dateTo", required: false, description: "Last salon day (YYYY-MM-DD), inclusive" })
  @ApiQuery({ name: "locationId", required: false, description: LOCATION_DESCRIPTION })
  appointmentsCsv(@Req() req: any, @Res() res: Response, @Query() q: AppointmentsExportQueryDto) {
    return this.appointments("csv", req, res, q);
  }
  @Get("appointments.xlsx")
  @Roles(...SALON_MANAGERS)
  @ApiQuery({ name: "dateFrom", required: false, description: "First salon day (YYYY-MM-DD), inclusive" })
  @ApiQuery({ name: "dateTo", required: false, description: "Last salon day (YYYY-MM-DD), inclusive" })
  @ApiQuery({ name: "locationId", required: false, description: LOCATION_DESCRIPTION })
  appointmentsXlsx(@Req() req: any, @Res() res: Response, @Query() q: AppointmentsExportQueryDto) {
    return this.appointments("xlsx", req, res, q);
  }

  @Get("payments.csv")
  @Roles(...SALON_MANAGERS)
  @ApiQuery({ name: "locationId", required: false, description: LOCATION_DESCRIPTION })
  paymentsCsv(@Req() req: any, @Res() res: Response, @Query() q: PaymentsExportQueryDto) {
    return this.payments("csv", req, res, q);
  }
  @Get("payments.xlsx")
  @Roles(...SALON_MANAGERS)
  @ApiQuery({ name: "locationId", required: false, description: LOCATION_DESCRIPTION })
  paymentsXlsx(@Req() req: any, @Res() res: Response, @Query() q: PaymentsExportQueryDto) {
    return this.payments("xlsx", req, res, q);
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
