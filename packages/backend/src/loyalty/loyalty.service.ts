import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

export interface CreateLoyaltyProgramDto {
  tenantId: string;
  name: string;
  description?: string;
  isActive?: boolean;
  pointsPerEuro?: number;
  pointsValueInCents?: number;
  minPointsRedemption?: number;
  pointsExpirationDays?: number;
  welcomePoints?: number;
}

export interface CreateLoyaltyTierDto {
  programId: string;
  name: string;
  minPoints: number;
  pointsMultiplier: number;
}

export interface CreateLoyaltyRewardDto {
  programId: string;
  name: string;
  description?: string;
  type: 'discount' | 'free_service' | 'product' | 'voucher';
  pointsCost: number;
  discountPercent?: number;
  discountAmount?: number;
  isActive?: boolean;
}

@Injectable()
export class LoyaltyService {
  constructor(private prisma: PrismaService) {}

  // Loyalty Programs
  async createProgram(dto: CreateLoyaltyProgramDto) {
    return this.prisma.loyaltyProgram.create({
      data: {
        tenantId: dto.tenantId,
        name: dto.name,
        description: dto.description,
        isActive: dto.isActive ?? true,
        pointsPerEuro: dto.pointsPerEuro ?? 1,
        pointsValueInCents: dto.pointsValueInCents ?? 1,
        minPointsRedemption: dto.minPointsRedemption ?? 100,
        pointsExpirationDays: dto.pointsExpirationDays,
        welcomePoints: dto.welcomePoints ?? 0,
      },
    });
  }

  async getPrograms(tenantId: string) {
    return this.prisma.loyaltyProgram.findMany({
      where: { tenantId },
      include: {
        tiers: true,
        _count: {
          select: { members: true, rewards: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getProgram(id: string) {
    const program = await this.prisma.loyaltyProgram.findUnique({
      where: { id },
      include: {
        tiers: { orderBy: { minPoints: 'asc' } },
        rewards: true,
      },
    });

    if (!program) {
      throw new NotFoundException('Loyalty program not found');
    }

    return program;
  }

  async updateProgram(id: string, dto: Partial<CreateLoyaltyProgramDto>) {
    return this.prisma.loyaltyProgram.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        isActive: dto.isActive,
        pointsPerEuro: dto.pointsPerEuro,
        pointsValueInCents: dto.pointsValueInCents,
        minPointsRedemption: dto.minPointsRedemption,
        pointsExpirationDays: dto.pointsExpirationDays,
        welcomePoints: dto.welcomePoints,
      },
    });
  }

  async deleteProgram(id: string) {
    return this.prisma.loyaltyProgram.delete({ where: { id } });
  }

  // Loyalty Tiers
  async createTier(dto: CreateLoyaltyTierDto) {
    return this.prisma.loyaltyTier.create({
      data: {
        programId: dto.programId,
        name: dto.name,
        minPoints: dto.minPoints,
        pointsMultiplier: dto.pointsMultiplier,
      },
    });
  }

  async updateTier(id: string, dto: Partial<CreateLoyaltyTierDto>) {
    return this.prisma.loyaltyTier.update({
      where: { id },
      data: {
        name: dto.name,
        minPoints: dto.minPoints,
        pointsMultiplier: dto.pointsMultiplier,
      },
    });
  }

  async deleteTier(id: string) {
    return this.prisma.loyaltyTier.delete({ where: { id } });
  }

  // Loyalty Rewards
  async createReward(dto: CreateLoyaltyRewardDto) {
    return this.prisma.loyaltyReward.create({
      data: {
        programId: dto.programId,
        name: dto.name,
        description: dto.description,
        type: dto.type,
        pointsCost: dto.pointsCost,
        discountPercent: dto.discountPercent,
        discountAmount: dto.discountAmount,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async getRewards(programId: string) {
    return this.prisma.loyaltyReward.findMany({
      where: { programId },
      orderBy: { pointsCost: 'asc' },
    });
  }

  async updateReward(id: string, dto: Partial<CreateLoyaltyRewardDto>) {
    return this.prisma.loyaltyReward.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        type: dto.type,
        pointsCost: dto.pointsCost,
        discountPercent: dto.discountPercent,
        discountAmount: dto.discountAmount,
        isActive: dto.isActive,
      },
    });
  }

  async deleteReward(id: string) {
    return this.prisma.loyaltyReward.delete({ where: { id } });
  }

  // Loyalty Members
  async addMember(clientId: string, programId: string) {
    // Check if already a member
    const existing = await this.prisma.loyaltyMember.findUnique({
      where: {
        clientId_programId: {
          clientId,
          programId,
        },
      },
    });

    if (existing) {
      return existing;
    }

    // Get welcome points
    const program = await this.prisma.loyaltyProgram.findUnique({
      where: { id: programId },
    });

    return this.prisma.loyaltyMember.create({
      data: {
        clientId,
        programId,
        currentPoints: program?.welcomePoints ?? 0,
        lifetimePoints: program?.welcomePoints ?? 0,
        totalEarned: program?.welcomePoints ?? 0,
      },
    });
  }

  async getMembers(programId: string) {
    return this.prisma.loyaltyMember.findMany({
      where: { programId },
      include: {
        client: true,
        program: true,
      },
      orderBy: { currentPoints: 'desc' },
    });
  }

  async getClientLoyalty(clientId: string) {
    return this.prisma.loyaltyMember.findMany({
      where: { clientId },
      include: {
        program: true,
      },
    });
  }

  // Points Management
  async awardPoints(memberId: string, points: number, description: string) {
    const member = await this.prisma.loyaltyMember.findUnique({
      where: { id: memberId },
    });

    if (!member) {
      throw new NotFoundException('Loyalty member not found');
    }

    // Update member points
    return this.prisma.loyaltyMember.update({
      where: { id: memberId },
      data: {
        currentPoints: { increment: points },
        lifetimePoints: { increment: points },
        totalEarned: { increment: points },
        lastActivityAt: new Date(),
      },
    });
  }

  async redeemPoints(memberId: string, points: number, rewardId: string) {
    const member = await this.prisma.loyaltyMember.findUnique({
      where: { id: memberId },
    });

    if (!member) {
      throw new NotFoundException('Loyalty member not found');
    }

    if (member.currentPoints < points) {
      throw new Error('Insufficient points');
    }

    const reward = await this.prisma.loyaltyReward.findUnique({
      where: { id: rewardId },
    });

    if (!reward) {
      throw new NotFoundException('Reward not found');
    }

    // Update member points
    const updated = await this.prisma.loyaltyMember.update({
      where: { id: memberId },
      data: {
        currentPoints: { decrement: points },
        totalRedeemed: { increment: points },
        lastActivityAt: new Date(),
      },
    });

    // Record redemption
    await this.prisma.loyaltyRedemption.create({
      data: {
        memberId,
        rewardId,
        pointsSpent: points,
      },
    });

    return updated;
  }

  // Get client points balance
  async getClientPoints(clientId: string, programId: string) {
    const member = await this.prisma.loyaltyMember.findFirst({
      where: { clientId, programId },
      include: { program: true },
    });

    if (!member) {
      return { points: 0, lifetimePoints: 0, tier: 'bronze', programName: null };
    }

    return {
      points: member.currentPoints,
      lifetimePoints: member.lifetimePoints,
      totalSpent: member.totalSpent,
      programName: member.program.name,
    };
  }
}
