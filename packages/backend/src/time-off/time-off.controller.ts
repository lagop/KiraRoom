import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles, SALON_MANAGERS, SALON_TEAM } from "../auth/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import {
  CreateTimeOffDto,
  CreateTimeOffRequestDto,
  DecideTimeOffDto,
  TimeOffQueryDto,
  TimeOffRequestsQueryDto,
  UpdateTimeOffDto,
} from "./dto/time-off.dto";
import { TimeOffService, TimeOffUser } from "./time-off.service";
import { TimeOffRequestsService } from "./time-off-requests.service";

/**
 * Time off and salon closures. Reading is for the whole team (the calendar
 * shades who is away); recording, changing and removing them is for whoever
 * runs the salon. A professional (staff) asks for their own time off through
 * /time-off/requests, and the salon approves or rejects it. The salon is
 * always the caller's, from the token.
 */
@ApiTags("time-off")
@Controller("time-off")
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class TimeOffController {
  constructor(
    private readonly timeOff: TimeOffService,
    private readonly requests: TimeOffRequestsService,
  ) {}

  @Get()
  @Roles(...SALON_TEAM)
  @ApiOperation({ summary: "Time off and closures touching a range of days" })
  list(@CurrentUser() user: TimeOffUser, @Query() query: TimeOffQueryDto) {
    return this.timeOff.list(user, query);
  }

  // Literal paths before ":id".
  @Post("preview")
  @HttpCode(200)
  @Roles(...SALON_MANAGERS)
  @ApiOperation({ summary: "Appointments new time off would clash with (nothing is saved)" })
  preview(@CurrentUser() user: TimeOffUser, @Body() dto: CreateTimeOffDto) {
    return this.timeOff.preview(user, dto);
  }

  // Requests: a professional asks for their own time off.

  @Get("requests/mine")
  @Roles(UserRole.staff)
  @ApiOperation({ summary: "The caller's own time off and requests, recent and ahead" })
  myRequests(@CurrentUser() user: TimeOffUser) {
    return this.requests.mine(user);
  }

  @Get("requests/count")
  @Roles(...SALON_MANAGERS)
  @ApiOperation({ summary: "How many time off requests wait for an answer" })
  pendingCount(@CurrentUser() user: TimeOffUser) {
    return this.requests.pendingCount(user);
  }

  @Get("requests")
  @Roles(...SALON_MANAGERS)
  @ApiOperation({ summary: "The salon's time off requests (pending by default)" })
  listRequests(@CurrentUser() user: TimeOffUser, @Query() query: TimeOffRequestsQueryDto) {
    return this.requests.list(user, query);
  }

  @Post("requests/preview")
  @HttpCode(200)
  @Roles(UserRole.staff)
  @ApiOperation({ summary: "Appointments the caller's request would clash with (nothing is saved)" })
  previewRequest(@CurrentUser() user: TimeOffUser, @Body() dto: CreateTimeOffRequestDto) {
    return this.requests.preview(user, dto);
  }

  @Post("requests")
  @Roles(UserRole.staff)
  @ApiOperation({ summary: "Ask for time off for oneself (pending until approved)" })
  createRequest(@CurrentUser() user: TimeOffUser, @Body() dto: CreateTimeOffRequestDto) {
    return this.requests.create(user, dto);
  }

  @Delete("requests/:id")
  @Roles(UserRole.staff)
  @ApiOperation({ summary: "Withdraw one's own request while it is pending" })
  cancelRequest(@CurrentUser() user: TimeOffUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.requests.cancel(user, id);
  }

  @Post(":id/approve")
  @HttpCode(200)
  @Roles(...SALON_MANAGERS)
  @ApiOperation({ summary: "Approve a pending request: from now on it blocks the agenda" })
  approve(
    @CurrentUser() user: TimeOffUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: DecideTimeOffDto,
  ) {
    return this.requests.approve(user, id, dto);
  }

  @Post(":id/reject")
  @HttpCode(200)
  @Roles(...SALON_MANAGERS)
  @ApiOperation({ summary: "Reject a pending request, with an optional reason" })
  reject(
    @CurrentUser() user: TimeOffUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: DecideTimeOffDto,
  ) {
    return this.requests.reject(user, id, dto);
  }

  // The salon records time off directly.

  @Post()
  @Roles(...SALON_MANAGERS)
  @ApiOperation({ summary: "Record time off, or a closure of the whole salon" })
  create(@CurrentUser() user: TimeOffUser, @Body() dto: CreateTimeOffDto) {
    return this.timeOff.create(user, dto);
  }

  @Patch(":id")
  @Roles(...SALON_MANAGERS)
  @ApiOperation({ summary: "Change the days, hours, kind or note of time off" })
  update(
    @CurrentUser() user: TimeOffUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateTimeOffDto,
  ) {
    return this.timeOff.update(user, id, dto);
  }

  @Delete(":id")
  @Roles(...SALON_MANAGERS)
  @ApiOperation({ summary: "Remove time off" })
  remove(@CurrentUser() user: TimeOffUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.timeOff.remove(user, id);
  }
}
