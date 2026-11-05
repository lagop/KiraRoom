import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

/**
 * Bodies of PUT /appointments/:id/cancel and /complete. They were read as a
 * bare `@Body("reason")` / `@Body("notes")`, which the ValidationPipe does
 * not check: any type and any length went into the row (and, for the
 * reason, into the client's cancellation notice).
 */

export const CANCEL_REASON_MAX = 1000;
export const COMPLETION_NOTES_MAX = 5000;

export class CancelAppointmentDto {
  @ApiPropertyOptional({ maxLength: CANCEL_REASON_MAX })
  @IsOptional()
  @IsString({ message: "El motivo no es válido" })
  @MaxLength(CANCEL_REASON_MAX, {
    message: `El motivo es demasiado largo (máximo ${CANCEL_REASON_MAX} caracteres)`,
  })
  reason?: string;
}

export class CompleteAppointmentDto {
  @ApiPropertyOptional({ maxLength: COMPLETION_NOTES_MAX })
  @IsOptional()
  @IsString({ message: "Las notas no son válidas" })
  @MaxLength(COMPLETION_NOTES_MAX, {
    message: `Las notas son demasiado largas (máximo ${COMPLETION_NOTES_MAX} caracteres)`,
  })
  notes?: string;
}
