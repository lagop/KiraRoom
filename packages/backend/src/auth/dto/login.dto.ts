import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ description: 'Email address', example: 'owner@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ description: 'Password', example: 'securePassword123' })
  @IsString()
  @MinLength(8)
  password: string;

  /**
   * The salon whose site the client is signing in on. A client's email is
   * unique per salon, not globally, so without this a client of two salons
   * was signed into whichever row the database returned first -- possibly
   * the other salon, on this salon's site.
   */
  @ApiProperty({ required: false, description: 'Salon slug (client sign-in on a salon site)' })
  @IsOptional()
  @IsString()
  tenantSlug?: string;
}
