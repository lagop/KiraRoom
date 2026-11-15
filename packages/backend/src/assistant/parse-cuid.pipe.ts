import { BadRequestException, PipeTransform } from '@nestjs/common';

/**
 * The copilot's tables (AssistantConversation, AssistantMessage,
 * ActionApproval) use cuid ids, not uuids. ParseUUIDPipe rejected every
 * real id: the panel could not load a conversation's messages ("Validation
 * failed (uuid is expected)") and no action card could be approved.
 * This keeps the SEC-2 guarantee (a malformed id never reaches Prisma)
 * for cuid ids.
 */
const CUID = /^c[a-z0-9]{20,31}$/;

export class ParseCuidPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== 'string' || !CUID.test(value)) {
      throw new BadRequestException('Validation failed (id is expected)');
    }
    return value;
  }
}
