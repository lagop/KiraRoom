import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { hashPassword } from "../saas/saas.helpers";
import { PrismaService } from "../common/prisma/prisma.service";
import { CreateClientDto, UpdateClientDto, UpdateMyProfileDto, ChangeMyPasswordDto } from "./dto";
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
  CLIENT_EMAIL_TAKEN,
} from "./client-write";
import {
  birthDateRange,
  clientListOrderBy,
  clientSearchSql,
  type ClientListQuery,
  type ClientPage,
} from "./client-search";

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
    const data = buildClientCreateData(tenantId, dto);
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

  /** A client reading her own record: her details, no visit list. */
  async findSelfRecord(tenantId: string, id: string) {
    const client = await this.prisma.client.findFirst({
      where: { id, tenantId },
      select: CLIENT_DETAIL_SELECT,
    });
    if (!client) throw new NotFoundException("Cliente no encontrado");
    return client;
  }

  /**
   * Staff (`scope.professionalId`) may edit their own clients (see
   * findOne) but not change their email (it is how she signs in) or her
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
      const email = updateClientDto.email === undefined ? undefined : updateClientDto.email?.trim() || null;
      if (email !== undefined && email !== client.email) {
        throw new ForbiddenException(STAFF_MAY_NOT_CHANGE);
      }
      if (updateClientDto.status !== undefined && updateClientDto.status !== client.status) {
        throw new ForbiddenException(STAFF_MAY_NOT_CHANGE);
      }
    }

    const data = buildClientUpdateData(updateClientDto, client);
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

  /**
   * What the account page shows a client about themselves. It read
   * /admin/clients/:id, which is owner/admin only, so it always failed and
   * the page showed whatever the browser had kept since sign-in.
   */
  async getSelf(tenantId: string, clientId: string) {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, tenantId },
      select: {
        id: true,
        tenantId: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        preferredLanguage: true,
      },
    });
    if (!client) throw new NotFoundException("Cliente no encontrado");
    return client;
  }

  /**
   * A client editing their own profile from the salon site. The account
   * page used to PATCH /clients/:id, a route that does not exist and whose
   * PUT twin excludes the client role, so every save failed.
   */
  async updateSelf(tenantId: string, clientId: string, dto: UpdateMyProfileDto) {
    const { currentPassword, ...fields } = dto;
    const data: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      data[key] = typeof value === "string" ? value.trim() : value;
    }
    // An emptied phone is "no phone", not an empty string the SMS sender
    // would try.
    if (data.phone === "") data.phone = null;
    if (data.firstName === "") {
      throw new BadRequestException("El nombre no puede quedar vacío");
    }

    if (data.email !== undefined) {
      const current = await this.prisma.client.findFirst({
        where: { id: clientId, tenantId },
        select: { email: true, passwordHash: true },
      });
      if (!current) throw new NotFoundException("Cliente no encontrado");
      if (data.email === current.email) {
        delete data.email;
      } else {
        // Changing the sign-in address takes the password, like changing
        // the password does (see changeOwnPassword).
        if (!current.passwordHash || !currentPassword) {
          throw new BadRequestException(
            "Para cambiar el email escribe tu contraseña actual",
          );
        }
        if (!(await bcrypt.compare(currentPassword, current.passwordHash))) {
          throw new BadRequestException("La contraseña actual no es correcta");
        }
      }
    }

    try {
      return await this.prisma.client.update({
        where: { id: clientId, tenantId },
        // A new sign-in address ends every session (tokenVersion), as a new
        // password does: whoever had the account under the old one is out.
        data: data.email !== undefined ? { ...data, tokenVersion: { increment: 1 } } : data,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          preferredLanguage: true,
        },
      });
    } catch (error: any) {
      if (error?.code === "P2002") {
        // @@unique([tenantId, email])
        throw new ConflictException(CLIENT_EMAIL_TAKEN);
      }
      if (error?.code === "P2025") {
        throw new NotFoundException("Cliente no encontrado");
      }
      throw error;
    }
  }

  /**
   * A client changing their own password. It needs the current one: a
   * borrowed session must not be enough to lock the owner out. The account
   * page used to say "Contraseña actualizada" without calling anything.
   */
  async changeOwnPassword(tenantId: string, clientId: string, dto: ChangeMyPasswordDto) {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, tenantId },
      select: { passwordHash: true },
    });
    if (!client?.passwordHash) {
      throw new BadRequestException("Esta cuenta no tiene contraseña");
    }
    const matches = await bcrypt.compare(dto.currentPassword, client.passwordHash);
    if (!matches) {
      // 400, not 401: the web client treats any 401 as an expired session
      // and logs out, which would punish a typo by ending the session.
      throw new BadRequestException("La contraseña actual no es correcta");
    }
    // Every session ends (tokenVersion), so one opened with the old
    // password does not outlive it.
    await this.prisma.client.update({
      where: { id: clientId, tenantId },
      data: { passwordHash: await hashPassword(dto.newPassword), tokenVersion: { increment: 1 } },
    });
  }
}
