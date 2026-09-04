# Appointment Activity Tracking Design

## Current Schema Analysis

The current Appointment model in the Prisma schema already has some tracking capabilities:
- `createdAt` and `updatedAt` timestamps
- Status tracking with `status` field
- Various timestamps for appointment lifecycle (checkInTime, startTime, completionTime)

## Proposed Activity Tracking Schema

### Option 1: Add Activity Field to Appointment Model

```prisma
model Appointment {
  // ... existing fields ...
  
  // Add activity tracking field
  activity Json @default("[]")
  
  // ... rest of model ...
}
```

**Pros:**
- Simple implementation
- All activity data in one place
- Easy to query with appointment

**Cons:**
- JSON field can become large over time
- Limited querying capabilities
- No referential integrity

### Option 2: Create Separate Activity Model

```prisma
model AppointmentActivity {
  id            String   @id @default(uuid())
  createdAt     DateTime @default(now())
  
  // Relationship
  appointmentId String
  appointment   Appointment @relation(fields: [appointmentId], references: [id], onDelete: Cascade)
  
  // Activity data
  action        String
  details       Json
  userId        String?
  
  @@index([appointmentId])
  @@index([createdAt])
}
```

**Pros:**
- Proper relational structure
- Better querying capabilities
- Scalable for large activity volumes
- Can track user who made changes

**Cons:**
- More complex implementation
- Requires joins to query
- Additional database table

## Recommended Approach

I recommend **Option 2** (separate Activity model) because:

1. **Scalability**: Activity tracking can grow significantly over time
2. **Querying**: Need to filter/sort activities by date, user, action type
3. **Data Integrity**: Proper relationships ensure data consistency
4. **Flexibility**: Can extend with additional metadata as needed

## Activity Data Structure

Each activity entry should include:

```typescript
interface AppointmentActivity {
  id: string;
  createdAt: Date;
  appointmentId: string;
  action: string; // e.g., "status_changed", "service_updated", "notes_added"
  details: {
    from?: any; // Previous value
    to?: any;   // New value
    field?: string; // Which field changed
    userId?: string; // Who made the change
    userName?: string; // User's name
    timestamp: string; // ISO timestamp
  };
}
```

## Implementation Plan

1. **Database Migration**:
   - Create new AppointmentActivity model
   - Add relationship to Appointment

2. **Backend Changes**:
   - Update appointments.service.ts to log activities
   - Create activity logging utility
   - Add activity endpoints if needed

3. **Frontend Changes**:
   - Fetch and display activities in appointment drawer
   - Add activity timeline component
   - Style activity entries

4. **Status Tracking**:
   - Log all status changes automatically
   - Include timestamps and user information
   - Show status history in activity timeline

## Example Activity Entries

```json
// Status change activity
{
  "action": "status_changed",
  "details": {
    "from": "pending",
    "to": "confirmed",
    "userId": "user123",
    "userName": "John Doe",
    "timestamp": "2026-01-16T12:00:00.000Z"
  }
}

// Service update activity
{
  "action": "service_updated",
  "details": {
    "field": "serviceId",
    "from": "service123",
    "to": "service456",
    "userId": "user123",
    "timestamp": "2026-01-16T12:15:00.000Z"
  }
}

// Notes added activity
{
  "action": "notes_added",
  "details": {
    "notes": "Client requested special attention",
    "userId": "user123",
    "timestamp": "2026-01-16T12:30:00.000Z"
  }
}
```

## Next Steps

1. Create the database migration for AppointmentActivity model
2. Implement activity logging in the backend service
3. Update frontend to display activities
4. Test the complete implementation