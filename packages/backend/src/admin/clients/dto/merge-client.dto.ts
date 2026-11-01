import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** POST /admin/clients/:id/merge: the record merged INTO :id (and then deleted). */
export class MergeClientDto {
  @ApiProperty({ description: 'The duplicate record whose history moves to :id' })
  @IsUUID()
  sourceClientId: string;
}
