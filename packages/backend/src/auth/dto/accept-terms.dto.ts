import { Equals } from "class-validator";

/** "He leído y acepto los términos actualizados": the box must be ticked. */
export class AcceptTermsDto {
  @Equals(true, { message: "Marca la casilla para aceptar los términos actualizados." })
  accept!: boolean;
}
