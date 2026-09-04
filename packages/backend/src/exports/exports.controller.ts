import {
  Controller,
  Get,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { ExportsService, ExportEntity } from "./exports.service";

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
  ) {
    return this.service.stream(req.user.tenantId, entity, format, res);
  }

  @Get("clients.csv")
  clientsCsv(@Req() req: any, @Res() res: Response) {
    return this.handle("clients", "csv", req, res);
  }
  @Get("clients.xlsx")
  clientsXlsx(@Req() req: any, @Res() res: Response) {
    return this.handle("clients", "xlsx", req, res);
  }

  @Get("appointments.csv")
  appointmentsCsv(@Req() req: any, @Res() res: Response) {
    return this.handle("appointments", "csv", req, res);
  }
  @Get("appointments.xlsx")
  appointmentsXlsx(@Req() req: any, @Res() res: Response) {
    return this.handle("appointments", "xlsx", req, res);
  }

  @Get("payments.csv")
  paymentsCsv(@Req() req: any, @Res() res: Response) {
    return this.handle("payments", "csv", req, res);
  }
  @Get("payments.xlsx")
  paymentsXlsx(@Req() req: any, @Res() res: Response) {
    return this.handle("payments", "xlsx", req, res);
  }

  @Get("services.csv")
  servicesCsv(@Req() req: any, @Res() res: Response) {
    return this.handle("services", "csv", req, res);
  }
  @Get("services.xlsx")
  servicesXlsx(@Req() req: any, @Res() res: Response) {
    return this.handle("services", "xlsx", req, res);
  }

  @Get("professionals.csv")
  professionalsCsv(@Req() req: any, @Res() res: Response) {
    return this.handle("professionals", "csv", req, res);
  }
  @Get("professionals.xlsx")
  professionalsXlsx(@Req() req: any, @Res() res: Response) {
    return this.handle("professionals", "xlsx", req, res);
  }

  @Get("wallet-transactions.csv")
  walletTxCsv(@Req() req: any, @Res() res: Response) {
    return this.handle("wallet-transactions", "csv", req, res);
  }
  @Get("wallet-transactions.xlsx")
  walletTxXlsx(@Req() req: any, @Res() res: Response) {
    return this.handle("wallet-transactions", "xlsx", req, res);
  }

  @Get("gift-cards.csv")
  giftCardsCsv(@Req() req: any, @Res() res: Response) {
    return this.handle("gift-cards", "csv", req, res);
  }
  @Get("gift-cards.xlsx")
  giftCardsXlsx(@Req() req: any, @Res() res: Response) {
    return this.handle("gift-cards", "xlsx", req, res);
  }
}
