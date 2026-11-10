import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/** The salon's own rules for online payments (Ajustes > Cobros online). */
export class UpdateConnectSettingsDto {
  @ApiPropertyOptional({ description: 'A client with a completed visit is not asked for the señal' })
  @IsOptional()
  @IsBoolean()
  depositExemptReturning?: boolean;
}
