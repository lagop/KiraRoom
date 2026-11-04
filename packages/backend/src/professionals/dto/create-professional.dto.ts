import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEmail, IsBoolean, IsOptional, IsNotEmpty, IsNumber, Min, Max, IsArray, ArrayMaxSize, IsUUID, ValidateIf, IsIn } from 'class-validator';
import { IsWorkingHours } from '../working-hours-input';
import { CommissionRateInput } from '../optional-fields';

/**
 * No `tenantId` here on purpose: the tenant comes from the caller's token.
 * The dashboard sent placeholders ('default-tenant', 'default'), which the
 * tenant scope rejected with a 403. See services/dto/create-service.dto.ts.
 */
export class CreateProfessionalDto {
  @ApiProperty({ description: 'First name' })
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({ description: 'Last name' })
  @IsString()
  @IsNotEmpty()
  lastName: string;

  @ApiProperty({ description: 'Email address' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ description: 'Phone number', required: false })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({ description: 'Profile image URL', required: false })
  @IsString()
  @IsOptional()
  profileImage?: string;

  @ApiProperty({ description: 'Bio', required: false })
  @IsString()
  @IsOptional()
  bio?: string;

  @ApiProperty({ description: 'Specialties', required: false })
  @IsOptional()
  specialties?: string[];

  @ApiProperty({ description: 'Is active', required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiProperty({ description: 'Is owner', required: false })
  @IsBoolean()
  @IsOptional()
  isOwner?: boolean;

  @ApiProperty({ description: 'Position', required: false })
  @IsString()
  @IsOptional()
  position?: string;

  /** "Mostrar en la web" (public-site/public-professional.ts); left out: name and initial. */
  @ApiProperty({ description: 'How the public page and widget name her: full, initial (default) or hidden', required: false, enum: ['full', 'initial', 'hidden'] })
  @IsIn(['full', 'initial', 'hidden'], { message: 'Elige cómo se muestra en la web: nombre completo, nombre e inicial o no mostrar.' })
  @IsOptional()
  webNameDisplay?: 'full' | 'initial' | 'hidden';

  /** "Mostrar foto"; left out: no photo. */
  @ApiProperty({ description: 'Show her photo and portfolio on the public page and widget (default off)', required: false })
  @IsBoolean()
  @IsOptional()
  webShowPhoto?: boolean;

  @ApiProperty({ description: 'Commission rate', required: false })
  @CommissionRateInput()
  @IsOptional()
  @IsNumber({}, { message: 'La comisión debe ser un número.' })
  @Min(0, { message: 'La comisión va de 0 a 100 (%).' })
  @Max(100, { message: 'La comisión va de 0 a 100 (%).' })
  commissionRate?: number | null;

  @ApiProperty({ description: '"Comisión de productos": percent of the products sold at the till (0-100); null: the salon default', required: false })
  @CommissionRateInput()
  @IsOptional()
  @IsNumber({}, { message: 'La comisión de productos debe ser un número.' })
  @Min(0, { message: 'La comisión de productos va de 0 a 100 (%).' })
  @Max(100, { message: 'La comisión de productos va de 0 a 100 (%).' })
  productCommissionRate?: number | null;

  @ApiProperty({ description: 'Hire date', required: false })
  @IsString()
  @IsOptional()
  hireDate?: string;

  @ApiProperty({ description: 'Termination date', required: false })
  @IsString()
  @IsOptional()
  terminationDate?: string;

  @ApiProperty({
    description: 'Weekly schedule: one entry per shift, several per day for a split shift (max 21). Owners and admins only.',
    required: false,
    example: [
      { day: 'monday', openTime: '10:00', closeTime: '14:00' },
      { day: 'monday', openTime: '17:00', closeTime: '20:00' },
    ],
  })
  @IsOptional()
  @IsWorkingHours()
  workingHours?: Array<{ day: string; openTime: string; closeTime: string }>;

  @ApiProperty({ description: 'Availability', required: false })
  @IsOptional()
  availability?: any;

  @ApiProperty({ description: 'Settings', required: false })
  @IsOptional()
  settings?: any;

  @ApiProperty({ description: 'Stats', required: false })
  @IsOptional()
  stats?: any;

  /**
   * The salon's locations the professional works at (plan with multi-local),
   * checked as in the team API (AdminProfessionalsService: the plan's
   * multi-location feature, only this salon's open locations). Left out: not
   * touched. An empty list: none.
   */
  @ApiProperty({ description: 'Locations the professional works at', type: [String], required: false })
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID(undefined, { each: true, message: 'Alguno de los locales elegidos no es válido.' })
  @IsOptional()
  locationIds?: string[];

  /** Which of locationIds is their main one; the first when left out. */
  @ApiProperty({ description: 'Main location (one of locationIds)', required: false })
  @ValidateIf((o) => o.primaryLocationId !== undefined && o.primaryLocationId !== null && o.primaryLocationId !== '')
  @IsUUID(undefined, { message: 'El local principal no es válido.' })
  primaryLocationId?: string | null;
}
