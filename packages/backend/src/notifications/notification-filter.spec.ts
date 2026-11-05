import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NotificationFilterDto } from './dto';
import { NotificationsService } from './notifications.service';

/**
 * I11: the panel's "No leídas" tab sent unreadOnly=true, which the DTO did
 * not know (whitelist dropped it), so the tab listed everything. And a
 * plain isRead=false failed @IsBoolean because query values are text.
 */
const pipe = new ValidationPipe({ transform: true, whitelist: true });

async function parse(query: Record<string, string>): Promise<NotificationFilterDto> {
  return pipe.transform(query, { type: 'query', metatype: NotificationFilterDto });
}

describe('NotificationFilterDto (query booleans)', () => {
  it('reads isRead=false as false', async () => {
    expect((await parse({ isRead: 'false' })).isRead).toBe(false);
  });

  it('reads isRead=true as true', async () => {
    expect((await parse({ isRead: 'true' })).isRead).toBe(true);
  });

  it('keeps unreadOnly=true', async () => {
    expect((await parse({ unreadOnly: 'true' })).unreadOnly).toBe(true);
  });

  it('refuses a value that is not a boolean', async () => {
    await expect(parse({ isRead: 'maybe' })).rejects.toBeDefined();
  });
});

describe('NotificationsService.findForUser unread filter', () => {
  function serviceWith() {
    const findMany = jest.fn(async () => []);
    const count = jest.fn(async () => 0);
    const prisma = { notification: { findMany, count } };
    const svc = new NotificationsService(prisma as any, {} as any, {} as any);
    return { svc, findMany };
  }

  it('isRead=false lists only unread notices', async () => {
    const { svc, findMany } = serviceWith();
    await svc.findForUser('u-1', await parse({ isRead: 'false' }));
    expect((findMany.mock.calls[0] as any)[0].where).toMatchObject({ userId: 'u-1', isRead: false });
  });

  it('unreadOnly=true lists only unread notices', async () => {
    const { svc, findMany } = serviceWith();
    await svc.findForUser('u-1', await parse({ unreadOnly: 'true' }));
    expect((findMany.mock.calls[0] as any)[0].where).toMatchObject({ isRead: false });
  });
});
