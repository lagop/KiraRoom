import { format, parseISO, addDays, addHours, startOfDay, endOfDay, isBefore, isAfter } from 'date-fns';
import { es, enUS } from 'date-fns/locale';

export const formatDate = (date: Date | string, formatStr: string = 'dd/MM/yyyy', locale: 'es' | 'en' = 'es'): string => {
  const dateObj = typeof date === 'string' ? parseISO(date) : date;
  return format(dateObj, formatStr, { locale: locale === 'es' ? es : enUS });
};

export const formatTime = (time: string, locale: 'es' | 'en' = 'es'): string => {
  const [hours, minutes] = time.split(':');
  const date = new Date();
  date.setHours(parseInt(hours), parseInt(minutes));
  return format(date, 'HH:mm', { locale: locale === 'es' ? es : enUS });
};

export const formatDateTime = (date: Date | string, time: string, locale: 'es' | 'en' = 'es'): string => {
  const dateObj = typeof date === 'string' ? parseISO(date) : date;
  const [hours, minutes] = time.split(':');
  const dateTime = new Date(dateObj);
  dateTime.setHours(parseInt(hours), parseInt(minutes));
  return format(dateTime, 'dd/MM/yyyy HH:mm', { locale: locale === 'es' ? es : enUS });
};

export const getAvailableDates = (days: number = 30): string[] => {
  const dates: string[] = [];
  const today = new Date();
  
  for (let i = 1; i <= days; i++) {
    const date = addDays(today, i);
    dates.push(format(date, 'yyyy-MM-dd'));
  }
  
  return dates;
};

export const generateTimeSlots = (
  startTime: string = '09:00',
  endTime: string = '18:00',
  intervalMinutes: number = 30
): string[] => {
  const slots: string[] = [];
  const [startHour, startMinute] = startTime.split(':').map(Number);
  const [endHour, endMinute] = endTime.split(':').map(Number);
  
  let currentTime = new Date();
  currentTime.setHours(startHour, startMinute, 0, 0);
  
  const endDateTime = new Date();
  endDateTime.setHours(endHour, endMinute, 0, 0);
  
  while (isBefore(currentTime, endDateTime)) {
    slots.push(format(currentTime, 'HH:mm'));
    currentTime = addHours(currentTime, 0);
    currentTime.setMinutes(currentTime.getMinutes() + intervalMinutes);
  }
  
  return slots;
};

export const isDateAvailable = (date: string, bookedDates: string[]): boolean => {
  return !bookedDates.includes(date);
};

export const isTimeSlotAvailable = (
  date: string,
  time: string,
  bookedSlots: Array<{ date: string; time: string }>
): boolean => {
  return !bookedSlots.some(slot => slot.date === date && slot.time === time);
};

export const calculateEndTime = (startTime: string, durationMinutes: number): string => {
  const [hours, minutes] = startTime.split(':').map(Number);
  const start = new Date();
  start.setHours(hours, minutes, 0, 0);
  
  const end = addHours(start, 0);
  end.setMinutes(end.getMinutes() + durationMinutes);
  
  return format(end, 'HH:mm');
};

export const getBusinessDays = (days: number): string[] => {
  const businessDays: string[] = [];
  const today = new Date();
  
  for (let i = 1; businessDays.length < days; i++) {
    const date = addDays(today, i);
    const dayOfWeek = date.getDay();
    
    // Skip weekends (0 = Sunday, 6 = Saturday)
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      businessDays.push(format(date, 'yyyy-MM-dd'));
    }
  }
  
  return businessDays;
};

export const getWeekDates = (date: Date): string[] => {
  const week: string[] = [];
  const startOfWeek = new Date(date);
  const day = startOfWeek.getDay();
  const diff = startOfWeek.getDate() - day;
  startOfWeek.setDate(diff);
  
  for (let i = 0; i < 7; i++) {
    const currentDate = new Date(startOfWeek);
    currentDate.setDate(startOfWeek.getDate() + i);
    week.push(format(currentDate, 'yyyy-MM-dd'));
  }
  
  return week;
};

export const isWithinBusinessHours = (
  time: string,
  businessHours: Array<{
    dayOfWeek: number;
    isOpen: boolean;
    openTime?: string;
    closeTime?: string;
  }>,
  date?: string
): boolean => {
  const [hours, minutes] = time.split(':').map(Number);
  const requestedTime = hours * 60 + minutes;
  
  const targetDate = date ? parseISO(date) : new Date();
  const dayOfWeek = targetDate.getDay();
  
  const daySchedule = businessHours.find(dh => dh.dayOfWeek === dayOfWeek);
  
  if (!daySchedule || !daySchedule.isOpen || !daySchedule.openTime || !daySchedule.closeTime) {
    return false;
  }
  
  const [openHour, openMinute] = daySchedule.openTime.split(':').map(Number);
  const [closeHour, closeMinute] = daySchedule.closeTime.split(':').map(Number);
  
  const openTime = openHour * 60 + openMinute;
  const closeTime = closeHour * 60 + closeMinute;
  
  return requestedTime >= openTime && requestedTime <= closeTime;
};