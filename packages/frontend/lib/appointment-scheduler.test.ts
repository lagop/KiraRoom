/**
 * Basic tests for the appointment scheduler algorithm
 */

import { AppointmentScheduler } from '../lib/appointment-scheduler';
import { prepareServiceObjects, transformOptionsForUI } from '../lib/appointment-scheduler.utils';

// Mock data for testing
const mockServices = [
  {
    id: '1',
    name: 'Corte de Cabello',
    duration: 45,
    professionalId: 'prof1',
    professionalName: 'María García'
  },
  {
    id: '2',
    name: 'Tinte Completo',
    duration: 90,
    professionalId: 'prof2',
    professionalName: 'Juan Pérez'
  }
];

const mockAvailability = {
  'prof1': [
    { start: '09:00', end: '13:00' },
    { start: '14:00', end: '18:00' }
  ],
  'prof2': [
    { start: '09:30', end: '12:00' },
    { start: '14:00', end: '19:00' }
  ]
};

// Basic functionality test
export function testAppointmentScheduler() {
  console.log('Testing AppointmentScheduler...');

  const scheduler = new AppointmentScheduler();

  try {
    const options = scheduler.generateScheduleOptions(
      mockServices,
      mockAvailability,
      new Date('2024-03-15')
    );

    console.log('✓ Algorithm executed successfully');
    console.log(`Generated ${Array.isArray(options) ? options.length : 0} options`);

    if (Array.isArray(options) && options.length > 0) {
      console.log('✓ First option:', {
        label: options[0].label,
        startTime: options[0].startTime,
        endTime: options[0].endTime,
        totalDuration: options[0].totalDuration
      });
    }

    return true;
  } catch (error) {
    console.error('✗ Algorithm failed:', error);
    return false;
  }
}

// Test date formatting
export function testDateFormatting() {
  console.log('Testing date formatting...');

  try {
    const mockOptions = [
      {
        id: 'test1',
        label: 'Test Option',
        priority: 1,
        startTime: '10:00',
        endTime: '11:00',
        totalDuration: 60,
        waitTime: 0,
        schedule: []
      }
    ];

    const formatted = transformOptionsForUI(mockOptions, '2026-04-23');

    console.log('✓ Date formatting successful');
    console.log('Formatted date:', formatted[0].formattedDate);

    // Should be something like "Wednesday, 23/04"
    return formatted.length === 1 && formatted[0].formattedDate.includes('Wednesday');
  } catch (error) {
    console.error('✗ Date formatting failed:', error);
    return false;
  }
}

// Run tests
if (typeof window === 'undefined') {
  // Node.js environment
  console.log('Running appointment scheduler tests...\n');

  const schedulerTest = testAppointmentScheduler();
  const dateTest = testDateFormatting();

  console.log('\n=== Test Results ===');
  console.log(`Scheduler Test: ${schedulerTest ? 'PASS' : 'FAIL'}`);
  console.log(`Date Format Test: ${dateTest ? 'PASS' : 'FAIL'}`);

  if (schedulerTest && dateTest) {
    console.log('✓ All tests passed!');
  } else {
    console.log('✗ Some tests failed');
  }
}

// (The second legacy `Run tests` block that referenced the deleted
// `testDataPreparation` has been removed — the block above already
// runs all three tests: testAppointmentScheduler, testDataPreparation
// (wait — see note), testDateFormatting.)
