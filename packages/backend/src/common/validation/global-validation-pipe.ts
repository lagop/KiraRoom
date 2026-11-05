import { ValidationPipe, ValidationPipeOptions } from "@nestjs/common";

/**
 * The ValidationPipe the app installs globally (main.ts), in one place so
 * specs run the very same configuration.
 *
 * `transform` without `enableImplicitConversion`: a query string reaches a
 * DTO as text, so every numeric or boolean query field needs its own
 * `@Type(() => Number)` / transform. The widget's `duration=60` used to be
 * refused with a 400 because AvailableSlotsDto.duration lacked it.
 */
export const GLOBAL_VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: false,
  validationError: {
    target: true,
    value: true,
  },
};

export function createGlobalValidationPipe(): ValidationPipe {
  return new ValidationPipe(GLOBAL_VALIDATION_PIPE_OPTIONS);
}
