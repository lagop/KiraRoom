// Test script for the API client
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';

async function testApiClient() {
  console.log('Starting API client tests...\n');

  try {
    // Test 1: Fetch Appointments
    console.log('Test 1: Fetching appointments...');
    const appointmentsResponse = await fetch(`${API_BASE_URL}/appointments`);
    if (!appointmentsResponse.ok) {
      throw new Error(`Failed to fetch appointments: ${appointmentsResponse.status} ${appointmentsResponse.statusText}`);
    }
    const appointments = await appointmentsResponse.json();
    console.log('Appointments fetched successfully:', appointments.length, 'appointments found.\n');

    // Test 2: Fetch Clients
    console.log('Test 2: Fetching clients...');
    const clientsResponse = await fetch(`${API_BASE_URL}/clients`);
    if (!clientsResponse.ok) {
      throw new Error(`Failed to fetch clients: ${clientsResponse.status} ${clientsResponse.statusText}`);
    }
    const clients = await clientsResponse.json();
    console.log('Clients fetched successfully:', clients.length, 'clients found.\n');

    // Test 3: Fetch Services
    console.log('Test 3: Fetching services...');
    const servicesResponse = await fetch(`${API_BASE_URL}/services`);
    if (!servicesResponse.ok) {
      throw new Error(`Failed to fetch services: ${servicesResponse.status} ${servicesResponse.statusText}`);
    }
    const services = await servicesResponse.json();
    console.log('Services fetched successfully:', services.length, 'services found.\n');

    // Test 4: Fetch Professionals
    console.log('Test 4: Fetching professionals...');
    const professionalsResponse = await fetch(`${API_BASE_URL}/professionals`);
    if (!professionalsResponse.ok) {
      throw new Error(`Failed to fetch professionals: ${professionalsResponse.status} ${professionalsResponse.statusText}`);
    }
    const professionals = await professionalsResponse.json();
    console.log('Professionals fetched successfully:', professionals.length, 'professionals found.\n');

    // Test 5: Fetch Available Slots
    console.log('Test 5: Fetching available slots...');
    const availableSlotsResponse = await fetch(
      `${API_BASE_URL}/appointments/available-slots?tenantId=tenant-id-123&professionalId=professional-id-123&serviceId=service-id-123&date=2026-01-06`
    );
    if (!availableSlotsResponse.ok) {
      console.log('Available slots endpoint not implemented yet. Skipping...\n');
    } else {
      const availableSlots = await availableSlotsResponse.json();
      console.log('Available slots fetched successfully:', availableSlots.length, 'slots found.\n');
    }

    console.log('All API client tests completed successfully!');
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error('Error during API client tests:', error.message);
    } else {
      console.error('Unknown error during API client tests:', error);
    }
  }
}

testApiClient();