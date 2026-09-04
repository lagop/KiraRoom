import { BaseEntity, UserRole, ContactInfo } from './common';

export interface User extends BaseEntity {
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  isActive: boolean;
  isEmailVerified: boolean;
  lastLoginAt?: Date;
  password?: string; // Only for internal use, never expose
  profileImage?: string;
  phone?: string;
  preferences: UserPreferences;
  permissions: UserPermissions;
  twoFactorEnabled: boolean;
  twoFactorSecret?: string;
  loginAttempts: number;
  lockedUntil?: Date;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  emailVerificationToken?: string;
  emailVerificationExpires?: Date;
}

export interface UserPreferences {
  language: 'es' | 'en';
  timezone: string;
  dateFormat: string;
  timeFormat: '12h' | '24h';
  currency: string;
  theme: 'light' | 'dark' | 'auto';
  notifications: NotificationPreferences;
  dashboard: DashboardPreferences;
}

export interface NotificationPreferences {
  email: {
    newAppointments: boolean;
    cancellations: boolean;
    reminders: boolean;
    marketing: boolean;
    security: boolean;
  };
  push: {
    newAppointments: boolean;
    cancellations: boolean;
    reminders: boolean;
    system: boolean;
  };
  sms: {
    newAppointments: boolean;
    cancellations: boolean;
    reminders: boolean;
  };
}

export interface DashboardPreferences {
  defaultView: 'day' | 'week' | 'month';
  showCompleted: boolean;
  showCancelled: boolean;
  autoRefresh: boolean;
  refreshInterval: number; // seconds
}

export interface UserPermissions {
  canManageSalon: boolean;
  canManageStaff: boolean;
  canManageServices: boolean;
  canManageAppointments: boolean;
  canManageClients: boolean;
  canViewReports: boolean;
  canManageSettings: boolean;
  canManageBilling: boolean;
  canExportData: boolean;
  canIntegrate: boolean;
}

export interface CreateUserDto {
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  phone?: string;
  password: string;
  profileImage?: string;
}

export interface UpdateUserDto extends Partial<CreateUserDto> {
  isActive?: boolean;
  preferences?: Partial<UserPreferences>;
  permissions?: Partial<UserPermissions>;
}

export interface LoginDto {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface RegisterDto {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  phone?: string;
}

export interface PasswordResetDto {
  email: string;
}

export interface PasswordResetConfirmDto {
  token: string;
  newPassword: string;
}

export interface ChangePasswordDto {
  currentPassword: string;
  newPassword: string;
}

export interface VerifyEmailDto {
  token: string;
}

export interface UserSession {
  id: string;
  userId: string;
  token: string;
  refreshToken: string;
  deviceInfo: DeviceInfo;
  ipAddress: string;
  userAgent: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

export interface DeviceInfo {
  type: 'desktop' | 'mobile' | 'tablet';
  os: string;
  browser: string;
  isTrusted: boolean;
}

export interface AuthResponse {
  user: Omit<User, 'password'>;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface RefreshTokenDto {
  refreshToken: string;
}

export interface UserActivity {
  id: string;
  userId: string;
  action: string;
  resource?: string;
  resourceId?: string;
  ipAddress: string;
  userAgent: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}