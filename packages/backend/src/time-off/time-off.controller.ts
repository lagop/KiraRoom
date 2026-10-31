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
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles, SALON_MANAGERS, SALON_TEAM } from "../auth/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { CreateTimeOffDto, TimeOffQueryDto, UpdateTimeOffDto } from "./dto/time-off.dto";
import { TimeOffService, TimeOffUser } from "./time-off.service";

/**
 * Time off and salon closures. Reading is for the whole team (the calendar
 * shades who is away); recording, changing and removing them is for whoever
 * runs the salon. The salon is always the caller's, from the token.
 */
@ApiTags("time-off")
@Controller("time-off")
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class TimeOffController {
  constructor(private readonly timeOff: TimeOffService) {}

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
