import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ description: 'Email address', example: 'owner@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ description: 'Password', example: 'securePassword123' })
  @IsString()
  @MinLength(8)
  password: string;
}
