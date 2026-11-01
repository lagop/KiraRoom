import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { CreateClientDto, UpdateClientDto } from "./dto";
import { deleteClientKeepingHistory } from "../common/prisma/history-deletes";
import {
  CLIENT_APPOINTMENTS_LIMIT,
  CLIENT_APPOINTMENTS_SELECT,
  CLIENT_DETAIL_SELECT,
  CLIENT_LIST_SELECT,
} from "./client-select";
import {
  buildClientCreateData,
  buildClientUpdateData,
  rethrowClientWriteError,
} from "./client-write";
import {
  birthDateRange,
  clientListOrderBy,
  clientSearchSql,
  type ClientListQuery,
  type ClientPage,
} from "./client-search";
import { countryForPhone, normalizeClientEmail } from "./client-contact";

/**
 * Whose clients a caller may reach. Owner/admin: {} (the whole salon).
 * Staff: their professional id (see ClientsController.scopeFor).
 */
export interface ClientScope {
  professionalId?: string;
}

export const STAFF_MAY_NOT_CHANGE =
  "Solo el propietario o un administrador pueden cambiar el email o el estado de un cliente";

export interface ClientFilters {
  gender?: "male" | "female" | "other";
  minAge?: number;
  maxAge?: number;
  tags?: string[];
  loyaltyTier?: "bronze" | "silver" | "gold" | "platinum";
  status?: "active" | "inactive" | "blocked";
  minTotalSpent?: number;
  maxTotalSpent?: number;
  minVisits?: number;
  maxVisits?: number;
  hasEmail?: boolean;
}

/**
 * Clients with any of these tags. `tags` is a JSON array, and `hasSome`
 * (a filter of Postgres array columns) made Prisma refuse the query: the
 * campaign screen's tag filter answered 500. A JSON array is matched with
 * `array_contains` (Postgres `@>`), one tag at a time, OR'ed. Blank and
 * repeated tags are dropped; null when none is left.
 */
export function tagsFilter(tags?: string[] | null): Prisma.ClientWhereInput | null {
  const wanted = [...new Set((tags ?? []).map((t) => String(t).trim()).filter(Boolean))];
  if (wanted.length === 0) return null;
  return { OR: wanted.map((tag) => ({ tags: { array_contains: [tag] } })) };
}

@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateClientDto) {
    const country = await countryForPhone(this.prisma, tenantId, dto.phone);
    const data = buildClientCreateData(tenantId, dto, country);
    try {
      return await this.prisma.client.create({ data, select: CLIENT_DETAIL_SELECT });
    } catch (error) {
      rethrowClientWriteError(error);
    }
  }

  /**
   * The panel's client list. `scope.professionalId` (staff) narrows it to
   * the clients with at least one appointment with that professional.
   */
  async findAll(tenantId: string, scope: ClientScope = {}) {
    return this.prisma.client.findMany({
      where: { tenantId, ...this.scopeWhere(scope) },
      select: CLIENT_LIST_SELECT,
    });
  }

  /**
   * One page of the panel's client list (see client-search.ts): search by
   * name, email or phone, filter by status, sort. Staff get only their own
   * clients, as in findAll.
   */
  async findPage(
    tenantId: string,
    scope: ClientScope,
    query: ClientListQuery,
  ): Promise<ClientPage<Prisma.ClientGetPayload<{ select: typeof CLIENT_LIST_SELECT }>>> {
    const where: Prisma.ClientWhereInput = { tenantId, ...this.scopeWhere(scope) };
    if (query.status) where.status = query.status;
    const empty = { data: [], total: 0, page: query.page, pageSize: query.pageSize, totalPages: 0 };
    if (query.search || query.phoneDigits.length > 0) {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(clientSearchSql(tenantId, query));
      if (rows.length === 0) return empty;
      where.id = { in: rows.map((r) => r.id) };
    }
    const [data, total] = await Promise.all([
      this.prisma.client.findMany({
        where,
        select: CLIENT_LIST_SELECT,
        orderBy: clientListOrderBy(query),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.client.count({ where }),
    ]);
    return { data, total, page: query.page, pageSize: query.pageSize, totalPages: Math.ceil(total / query.pageSize) };
  }

  /** Staff see only the clients they have served or will serve. */
  private scopeWhere(scope: ClientScope): Prisma.ClientWhereInput {
    return scope.professionalId
      ? { appointments: { some: { professionalId: scope.professionalId } } }
      : {};
  }

  async findAllWithFilters(tenantId: string, filters: ClientFilters) {
    const now = new Date();
    const where: any = { tenantId };

    // Validate age filters
    if (filters.minAge !== undefined) {
      if (filters.minAge < 0 || filters.minAge > 120) {
        throw new BadRequestException(
          "La edad mínima debe estar entre 0 y 120",
        );
      }
    }

    if (filters.maxAge !== undefined) {
      if (filters.maxAge < 0 || filters.maxAge > 120) {
        throw new BadRequestException(
          "La edad máxima debe estar entre 0 y 120",
        );
      }
    }

    if (
      filters.minAge !== undefined &&
      filters.maxAge !== undefined &&
      filters.minAge > filters.maxAge
    ) {
      throw new BadRequestException(
        "La edad mínima no puede ser mayor que la edad máxima",
      );
    }

    // Filter by gender
    if (filters.gender) {
      where.gender = filters.gender;
    }

    // Filter by age range (from dateOfBirth; see birthDateRange).
    const born = birthDateRange(now, filters.minAge, filters.maxAge);
    if (born) where.dateOfBirth = born;

    // Filter by tags: any of them.
    const tagsWhere = tagsFilter(filters.tags);
    if (tagsWhere) where.AND = [...(where.AND ?? []), tagsWhere];

    // Filter by loyalty tier
    if (filters.loyaltyTier) {
      where.loyaltyTier = filters.loyaltyTier;
    }

    // Filter by status
    if (filters.status) {
      where.status = filters.status;
    } else {
      // Default to active clients only
      where.status = "active";
    }

    // Filter by total spent
    if (filters.minTotalSpent !== undefined) {
      where.totalSpent = { ...where.totalSpent, gte: filters.minTotalSpent };
    }
    if (filters.maxTotalSpent !== undefined) {
      where.totalSpent = { ...where.totalSpent, lte: filters.maxTotalSpent };
    }

    // Filter by visit count
    if (filters.minVisits !== undefined) {
      where.visitCount = { ...where.visitCount, gte: filters.minVisits };
    }
    if (filters.maxVisits !== undefined) {
      where.visitCount = { ...where.visitCount, lte: filters.maxVisits };
    }

    // Filter by email presence
    if (filters.hasEmail) {
      where.email = { not: null };
    }

    return this.prisma.client.findMany({
      where,
      select: CLIENT_LIST_SELECT,
    });
  }

  /**
   * One client's file: her details (health data included), and her visits
   * with what each one cost. Staff (`scope.professionalId`) only reach
   * clients they have an appointment with; any other id is a 404, as if
   * it did not exist.
   */
  async findOne(tenantId: string, id: string, scope: ClientScope = {}) {
    const client = await this.prisma.client.findFirst({
      where: { id, tenantId, ...this.scopeWhere(scope) },
      select: {
        ...CLIENT_DETAIL_SELECT,
        appointments: {
          select: CLIENT_APPOINTMENTS_SELECT,
          orderBy: [{ scheduledDate: "desc" }, { scheduledTime: "desc" }],
          take: CLIENT_APPOINTMENTS_LIMIT,
        },
      },
    });

    if (!client) {
      throw new NotFoundException("Cliente no encontrado");
    }

    return client;
  }

  /**
   * Staff (`scope.professionalId`) may edit their own clients (see
   * findOne) but not change their email (it is how the salon reaches her) or her
   * status (blocking is the manager's call): 403 when either differs from
   * what is stored. Sending the stored value back is fine.
   */
  async update(
    tenantId: string,
    id: string,
    updateClientDto: UpdateClientDto,
    scope: ClientScope = {},
  ) {
    const client = await this.prisma.client.findFirst({
      where: { id, tenantId, ...this.scopeWhere(scope) },
      select: { email: true, status: true, taxId: true, taxIdType: true },
    });

    if (!client) {
      throw new NotFoundException("Cliente no encontrado");
    }

    if (scope.professionalId) {
      // Compared as stored (lower case): the same address in other capitals
      // is not a change.
      const email = normalizeClientEmail(updateClientDto.email);
      if (email !== undefined && email !== normalizeClientEmail(client.email)) {
        throw new ForbiddenException(STAFF_MAY_NOT_CHANGE);
      }
      if (updateClientDto.status !== undefined && updateClientDto.status !== client.status) {
        throw new ForbiddenException(STAFF_MAY_NOT_CHANGE);
      }
    }

    const country = await countryForPhone(this.prisma, tenantId, updateClientDto.phone);
    const data = buildClientUpdateData(updateClientDto, client, country);
    try {
      return await this.prisma.client.update({
        where: { id, tenantId },
        data,
        select: CLIENT_DETAIL_SELECT,
      });
    } catch (error) {
      rethrowClientWriteError(error);
    }
  }

  /** History survives the delete: see common/prisma/history-deletes.ts. */
  async remove(tenantId: string, id: string) {
    return deleteClientKeepingHistory(this.prisma, tenantId, id);
  }
}
