import { z } from 'zod';

// General validation utilities
export const validateEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

export const validatePhone = (phone: string): boolean => {
  // Basic phone validation - can be enhanced based on requirements
  const phoneRegex = /^\+?[\d\s\-\(\)]{8,}$/;
  return phoneRegex.test(phone);
};

export const validateTimeFormat = (time: string): boolean => {
  const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
  return timeRegex.test(time);
};

export const validateDateFormat = (date: string): boolean => {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) return false;
  
  const parsedDate = new Date(date);
  return !isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === date;
};

export const validateCurrency = (currency: string): boolean => {
  const validCurrencies = ['EUR', 'USD', 'GBP', 'MXN', 'ARS', 'COP'];
  return validCurrencies.includes(currency.toUpperCase());
};

export const validateTimezone = (timezone: string): boolean => {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

export const sanitizeString = (str: string): string => {
  return str.trim().replace(/\s+/g, ' ');
};

export const validateSlug = (slug: string): boolean => {
  const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  return slugRegex.test(slug) && slug.length >= 3 && slug.length <= 50;
};

export const validatePassword = (password: string): { isValid: boolean; errors: string[] } => {
  const errors: string[] = [];
  
  if (password.length < 6) {
    errors.push('Password must be at least 6 characters long');
  }
  
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  
  if (!/\d/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  
  return {
    isValid: errors.length === 0,
    errors,
  };
};

export const validateUrl = (url: string): boolean => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

// Form validation helpers
export const createFieldValidator = <T>(schema: z.ZodSchema<T>) => {
  return (value: T) => {
    const result = schema.safeParse(value);
    return {
      isValid: result.success,
      errors: result.success ? [] : result.error.errors.map(e => e.message),
    };
  };
};

export const validateRequired = (value: any, fieldName: string): { isValid: boolean; error?: string } => {
  if (value === null || value === undefined || value === '') {
    return {
      isValid: false,
      error: `${fieldName} is required`,
    };
  }
  
  if (typeof value === 'string' && value.trim() === '') {
    return {
      isValid: false,
      error: `${fieldName} cannot be empty`,
    };
  }
  
  return { isValid: true };
};

export const validateMinLength = (value: string, minLength: number, fieldName: string): { isValid: boolean; error?: string } => {
  if (value.length < minLength) {
    return {
      isValid: false,
      error: `${fieldName} must be at least ${minLength} characters long`,
    };
  }
  
  return { isValid: true };
};

export const validateMaxLength = (value: string, maxLength: number, fieldName: string): { isValid: boolean; error?: string } => {
  if (value.length > maxLength) {
    return {
      isValid: false,
      error: `${fieldName} cannot exceed ${maxLength} characters`,
    };
  }
  
  return { isValid: true };
};

// Business logic validation
export const validateBusinessHours = (
  openTime: string,
  closeTime: string
): { isValid: boolean; error?: string } => {
  if (!validateTimeFormat(openTime) || !validateTimeFormat(closeTime)) {
    return {
      isValid: false,
      error: 'Invalid time format. Use HH:MM format',
    };
  }
  
  const [openHour, openMinute] = openTime.split(':').map(Number);
  const [closeHour, closeMinute] = closeTime.split(':').map(Number);
  
  const openMinutes = openHour * 60 + openMinute;
  const closeMinutes = closeHour * 60 + closeMinute;
  
  if (openMinutes >= closeMinutes) {
    return {
      isValid: false,
      error: 'Opening time must be before closing time',
    };
  }
  
  return { isValid: true };
};

export const validateAppointmentDuration = (duration: number): { isValid: boolean; error?: string } => {
  if (duration < 15) {
    return {
      isValid: false,
      error: 'Appointment duration must be at least 15 minutes',
    };
  }
  
  if (duration > 480) {
    return {
      isValid: false,
      error: 'Appointment duration cannot exceed 8 hours',
    };
  }
  
  return { isValid: true };
};

export const validatePrice = (price: number): { isValid: boolean; error?: string } => {
  if (price < 0) {
    return {
      isValid: false,
      error: 'Price cannot be negative',
    };
  }
  
  if (price > 10000) {
    return {
      isValid: false,
      error: 'Price cannot exceed €10,000',
    };
  }
  
  return { isValid: true };
};