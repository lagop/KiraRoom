import {
  Controller,
  Get,
  Param,
  NotFoundException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { PrismaService } from "../common/prisma/prisma.service";
import { Public } from "../auth/decorators/public.decorator";

@ApiTags("public")
@Controller("public-site")
export class PublicTenantController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("tenant/:slug")
  @ApiOperation({ summary: "Resolve a salon by slug or id (public)" })
  @ApiResponse({ status: 200, description: "Salon found" })
  @ApiResponse({ status: 404, description: "Salon not found" })
  async getBySlug(@Param("slug") slug: string) {
    const tenant = await this.prisma.tenant.findFirst({
      where: {
        OR: [{ slug }, { id: slug }],
      },
      select: {
        id: true,
        name: true,
        slug: true,
        logo: true,
        street: true,
        city: true,
        state: true,
        country: true,
        phone: true,
        email: true,
        description: true,
      },
    });

    if (!tenant) {
      throw new NotFoundException("Salon not found");
    }

    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      logo: tenant.logo,
      address: tenant.street,
      city: tenant.city,
      state: tenant.state,
      country: tenant.country,
      phone: tenant.phone,
      email: tenant.email,
      description: tenant.description,
    };
  }
}




