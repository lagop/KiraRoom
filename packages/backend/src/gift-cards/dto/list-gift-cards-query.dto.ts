import { Transform, Type } from "class-transformer";
import { IsBoolean, IsInt, IsOptional, Max, Min } from "class-validator";

/** `?page=&limit=&isActive=`: a bad value is a 400, never a 500. */
export class ListGiftCardsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "page debe ser un número entero" })
  @Min(1, { message: "page debe ser 1 o más" })
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "limit debe ser un número entero" })
  @Min(1, { message: "limit debe ser 1 o más" })
  @Max(100, { message: "limit no puede pasar de 100" })
  limit?: number;

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" || value === "1" || value === true
      ? true
      : value === "false" || value === "0" || value === false
        ? false
        : value,
  )
  @IsBoolean({ message: "isActive debe ser true o false" })
  isActive?: boolean;
}
