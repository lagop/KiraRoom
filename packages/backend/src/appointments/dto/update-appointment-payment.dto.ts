import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod, PaymentStatus } from '@prisma/client';

/**
 * The body of `PATCH /appointments/:id/payment`: the owner or a manager
 * correcting how an appointment stands (paid, refunded, pending). The till
 * no longer uses it -- a sale records its payments and the appointment's
 * paid amount itself (POST /pos/checkout). It used to be an inline type the
 * ValidationPipe could not see, so any status, any amount and any method
 * went straight into the row.
 */
export class UpdateAppointmentPaymentDto {
  @ApiProperty({ enum: PaymentStatus })
  @IsEnum(PaymentStatus)
  status!: PaymentStatus;

  @ApiProperty({
    description: 'Total paid for the appointment, in cents (the unit of appointments.amountPaid). Never more than its total.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  // 1M EUR: the cap the service checks against is the appointment's total;
  // this only keeps absurd numbers out of the arithmetic.
  @Max(100_000_000)
  amountPaid!: number;

  @ApiPropertyOptional({ enum: PaymentMethod })
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;
}
