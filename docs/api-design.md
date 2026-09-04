# API Design - Kira Studio

## Overview

RESTful API design for the beauty salon management system. All endpoints follow consistent patterns and include proper error handling, validation, and multi-tenant support.

## Base URL & Versioning
```
Base URL: https://api.kirastudio.com/api/v1
Development: http://localhost:3001/api/v1
```

## Authentication

### JWT Token-based Authentication
```http
Authorization: Bearer <jwt_token>
```

### Login Flow
```http
POST /auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123",
  "rememberMe": false
}

Response: 200 OK
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "email": "user@example.com",
      "firstName": "John",
      "lastName": "Doe",
      "role": "owner",
      "tenantId": "uuid"
    },
    "accessToken": "jwt_token",
    "refreshToken": "refresh_token",
    "expiresIn": 3600
  }
}
```

## API Structure

### 1. Authentication Endpoints

#### POST /auth/register
Register new user and salon
```http
{
  "firstName": "Juan",
  "lastName": "Pérez",
  "email": "juan@salon.com",
  "password": "securePassword123",
  "salonName": "Salón Juan",
  "salonSlug": "salon-juan",
  "phone": "+34 666 777 888"
}
```

#### POST /auth/login
Authenticate user
```http
{
  "email": "user@example.com",
  "password": "password123"
}
```

#### POST /auth/refresh
Refresh access token
```http
{
  "refreshToken": "refresh_token"
}
```

#### POST /auth/forgot-password
Request password reset
```http
{
  "email": "user@example.com"
}
```

#### POST /auth/reset-password
Reset password with token
```http
{
  "token": "reset_token",
  "newPassword": "newPassword123"
}
```

### 2. Salon Management Endpoints

#### GET /salons/profile
Get current salon profile
```http
Response: 200 OK
{
  "success": true,
  "data": {
    "id": "uuid",
    "name": "Salón Juan",
    "slug": "salon-juan",
    "description": "Peluquería moderna",
    "contact": {
      "email": "info@salonjuan.com",
      "phone": "+34 666 777 888",
      "whatsapp": "+34 666 777 888"
    },
    "address": {
      "street": "Calle Mayor 123",
      "city": "Madrid",
      "state": "Madrid",
      "postalCode": "28001",
      "country": "ES"
    },
    "settings": {
      "timezone": "Europe/Madrid",
      "currency": "EUR",
      "language": "es",
      "dateFormat": "DD/MM/YYYY",
      "timeFormat": "24h",
      "workingHours": [...]
    },
    "subscription": {
      "plan": "basic",
      "status": "active",
      "currentPeriodEnd": "2024-02-01"
    }
  }
}
```

#### PUT /salons/profile
Update salon profile
```http
{
  "name": "Salón Juan Actualizado",
  "description": "Nueva descripción",
  "contact": {
    "phone": "+34 666 777 999"
  }
}
```

#### GET /salons/settings
Get salon settings
```http
Response: 200 OK
{
  "success": true,
  "data": {
    "bookingSettings": {
      "advanceBookingDays": 30,
      "cancellationPolicy": {
        "advanceNotice": 24,
        "penaltyPercentage": 50,
        "refundPolicy": "partial"
      },
      "requireApproval": false,
      "allowOnlineCancellation": true
    },
    "notificationSettings": {
      "confirmation": {
        "email": true,
        "sms": false,
        "whatsapp": true
      },
      "reminders": {
        "email": true,
        "sms": true,
        "whatsapp": false,
        "hoursBefore": [24, 2]
      }
    }
  }
}
```

#### PUT /salons/settings
Update salon settings
```http
{
  "bookingSettings": {
    "advanceBookingDays": 45,
    "requireApproval": true
  }
}
```

### 3. Client Management Endpoints

#### GET /clients
List clients with pagination and filtering
```http
GET /clients?page=1&limit=20&search=juan&status=active&tags=vip
```

#### POST /clients
Create new client
```http
{
  "firstName": "María",
  "lastName": "García",
  "email": "maria@email.com",
  "phone": "+34 666 888 999",
  "dateOfBirth": "1990-05-15",
  "gender": "female",
  "source": "google",
  "preferredLanguage": "es",
  "notes": "Cliente frecuente"
}
```

#### GET /clients/:id
Get client details
```http
Response: 200 OK
{
  "success": true,
  "data": {
    "id": "uuid",
    "firstName": "María",
    "lastName": "García",
    "email": "maria@email.com",
    "phone": "+34 666 888 999",
    "status": "active",
    "loyalty": {
      "points": 150,
      "tier": "silver",
      "nextTierPoints": 50
    },
    "history": {
      "totalAppointments": 12,
      "lastAppointment": "2024-01-15T10:00:00Z",
      "averageSpent": 45.50,
      "favoriteServices": [...]
    },
    "preferences": {
      "preferredServices": ["uuid1", "uuid2"],
      "preferredTimes": {
        "timeOfDay": "afternoon",
        "dayOfWeek": [1, 3, 5]
      }
    }
  }
}
```

#### PUT /clients/:id
Update client
```http
{
  "firstName": "María",
  "lastName": "García Actualizada",
  "phone": "+34 666 888 777",
  "status": "active",
  "tags": ["vip", "frecuente"]
}
```

#### DELETE /clients/:id
Delete client (soft delete)

#### GET /clients/:id/appointments
Get client appointment history

### 4. Service Management Endpoints

#### GET /services
List services
```http
GET /services?category=hair&isActive=true&page=1&limit=20
```

#### POST /services
Create new service
```http
{
  "name": "Corte de Cabello",
  "description": "Corte y peinado profesional",
  "category": "hair",
  "duration": 60,
  "price": 35.00,
  "currency": "EUR",
  "isOnlineBookable": true,
  "requiresApproval": false,
  "bufferTime": 15,
  "staff": ["uuid1", "uuid2"],
  "images": ["https://..."],
  "tags": ["popular", "cabello"]
}
```

#### GET /services/:id
Get service details

#### PUT /services/:id
Update service

#### DELETE /services/:id
Delete service

### 5. Professional (Staff) Management Endpoints

#### GET /professionals
List professionals
```http
GET /professionals?isActive=true&specialty=hair&page=1&limit=20
```

#### POST /professionals
Create new professional
```http
{
  "firstName": "Ana",
  "lastName": "López",
  "email": "ana@salon.com",
  "phone": "+34 666 999 888",
  "position": "Peluquera Senior",
  "specialties": ["hair", "color"],
  "hireDate": "2024-01-01",
  "commissionRate": 15.00,
  "workingHours": [
    {
      "dayOfWeek": 1,
      "isOpen": true,
      "openTime": "09:00",
      "closeTime": "18:00"
    }
  ],
  "services": ["uuid1", "uuid2"]
}
```

#### GET /professionals/:id
Get professional details with schedule

#### PUT /professionals/:id
Update professional

#### GET /professionals/:id/schedule
Get professional schedule for date range
```http
GET /professionals/:id/schedule?startDate=2024-01-15&endDate=2024-01-21
```

### 6. Appointment Management Endpoints

#### GET /appointments
List appointments with filtering
```http
GET /appointments?status=confirmed&dateFrom=2024-01-15&dateTo=2024-01-21&professionalId=uuid&clientId=uuid&page=1&limit=20
```

#### POST /appointments
Create new appointment
```http
{
  "clientId": "uuid", // or clientInfo for new client
  "clientInfo": {
    "firstName": "Carlos",
    "lastName": "Ruiz",
    "email": "carlos@email.com",
    "phone": "+34 666 111 222"
  },
  "serviceId": "uuid",
  "professionalId": "uuid",
  "scheduledDate": "2024-01-20",
  "scheduledTime": "10:30",
  "notes": "Primera visita",
  "source": "online",
  "utmSource": "google",
  "utmCampaign": "peluqueria_madrid"
}
```

#### GET /appointments/:id
Get appointment details
```http
Response: 200 OK
{
  "success": true,
  "data": {
    "id": "uuid",
    "client": {
      "firstName": "María",
      "lastName": "García",
      "email": "maria@email.com",
      "phone": "+34 666 888 999"
    },
    "service": {
      "name": "Corte de Cabello",
      "duration": 60,
      "price": 35.00
    },
    "professional": {
      "firstName": "Ana",
      "lastName": "López"
    },
    "scheduledDate": "2024-01-20",
    "scheduledTime": "10:30",
    "duration": 60,
    "status": "confirmed",
    "paymentStatus": "pending",
    "totalAmount": 35.00,
    "location": "salon"
  }
}
```

#### PUT /appointments/:id
Update appointment
```http
{
  "serviceId": "uuid",
  "professionalId": "uuid",
  "scheduledDate": "2024-01-21",
  "scheduledTime": "14:00",
  "status": "confirmed",
  "notes": "Actualizado por cliente"
}
```

#### POST /appointments/:id/cancel
Cancel appointment
```http
{
  "reason": "Cliente canceló por enfermedad",
  "refundRequested": true
}
```

#### POST /appointments/:id/complete
Mark appointment as completed
```http
{
  "notes": "Servicio completado satisfactoriamente",
  "rating": 5,
  "review": "Excelente servicio, muy recomendado",
  "paymentReceived": true
}
```

### 7. Booking Widget Endpoints

#### GET /booking/availability
Get available time slots for booking
```http
GET /booking/availability?serviceId=uuid&date=2024-01-20&professionalId=uuid
```

#### Response
```http
{
  "success": true,
  "data": {
    "date": "2024-01-20",
    "service": {
      "id": "uuid",
      "name": "Corte de Cabello",
      "duration": 60,
      "price": 35.00
    },
    "slots": [
      {
        "time": "09:00",
        "isAvailable": true,
        "professional": {
          "id": "uuid",
          "firstName": "Ana",
          "lastName": "L."
        }
      },
      {
        "time": "10:30",
        "isAvailable": true,
        "professional": {
          "id": "uuid",
          "firstName": "Ana",
          "lastName": "L."
        }
      }
    ]
  }
}
```

#### POST /booking/appointments
Create appointment through booking widget
```http
{
  "serviceId": "uuid",
  "professionalId": "uuid",
  "scheduledDate": "2024-01-20",
  "scheduledTime": "10:30",
  "clientInfo": {
    "firstName": "Pedro",
    "lastName": "Martín",
    "email": "pedro@email.com",
    "phone": "+34 666 333 444"
  },
  "notes": "Cita desde web",
  "acceptTerms": true
}
```

### 8. Dashboard & Analytics Endpoints

#### GET /dashboard/stats
Get dashboard statistics
```http
GET /dashboard/stats?period=today&period=week&period=month
```

#### Response
```http
{
  "success": true,
  "data": {
    "today": {
      "appointments": 12,
      "revenue": 420.00,
      "clients": 8,
      "averageRating": 4.8
    },
    "thisWeek": {
      "appointments": 65,
      "revenue": 2340.00,
      "clients": 42,
      "newClients": 5
    },
    "thisMonth": {
      "appointments": 280,
      "revenue": 9800.00,
      "clients": 185,
      "newClients": 23
    }
  }
}
```

#### GET /dashboard/appointments
Get appointments for dashboard
```http
GET /dashboard/appointments?limit=10&status=upcoming
```

### 9. Notification Endpoints

#### GET /notifications
List notifications
```http
GET /notifications?type=appointment&status=unread&page=1&limit=20
```

#### POST /notifications/test
Send test notification
```http
{
  "channel": "email",
  "type": "appointment_confirmation",
  "recipient": "test@example.com",
  "data": {
    "appointmentId": "uuid"
  }
}
```

### 10. Reporting Endpoints

#### GET /reports/appointments
Appointment report
```http
GET /reports/appointments?startDate=2024-01-01&endDate=2024-01-31&groupBy=day&format=csv
```

#### GET /reports/revenue
Revenue report
```http
GET /reports/revenue?startDate=2024-01-01&endDate=2024-01-31&groupBy=service
```

## Error Handling

### Standard Error Response Format
```http
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Los datos proporcionados no son válidos",
    "details": [
      {
        "field": "email",
        "message": "El email debe tener un formato válido"
      }
    ]
  }
}
```

### Error Codes
- `VALIDATION_ERROR` - Request validation failed
- `AUTHENTICATION_REQUIRED` - Authentication required
- `INSUFFICIENT_PERMISSIONS` - User lacks permission
- `RESOURCE_NOT_FOUND` - Requested resource not found
- `TENANT_NOT_FOUND` - Tenant/salon not found
- `APPOINTMENT_CONFLICT` - Time slot already booked
- `SERVICE_UNAVAILABLE` - Service not available
- `PAYMENT_FAILED` - Payment processing failed
- `RATE_LIMIT_EXCEEDED` - Too many requests

## Rate Limiting

- **Authentication endpoints**: 5 requests per minute
- **Booking endpoints**: 10 requests per minute
- **General API**: 100 requests per minute
- **Reporting endpoints**: 20 requests per minute

## Pagination

All list endpoints support pagination:
```http
GET /clients?page=1&limit=20&sortBy=createdAt&sortOrder=desc
```

### Pagination Response
```http
{
  "success": true,
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8,
    "hasNext": true,
    "hasPrevious": false
  }
}
```

## Search & Filtering

### Common Query Parameters
- `search` - Text search across multiple fields
- `status` - Filter by status
- `dateFrom` / `dateTo` - Date range filtering
- `category` - Filter by category
- `tags` - Filter by tags (comma-separated)
- `isActive` - Filter by active status

### Example Searches
```http
GET /clients?search=maria&status=active&tags=vip,frecuente
GET /appointments?dateFrom=2024-01-15&dateTo=2024-01-21&status=confirmed
GET /services?category=hair&isActive=true
```

## Webhooks (Future)

### Appointment Events
```http
POST /webhooks/appointments
{
  "event": "appointment.created",
  "data": {
    "appointmentId": "uuid",
    "clientName": "María García",
    "serviceName": "Corte de Cabello",
    "scheduledDate": "2024-01-20",
    "scheduledTime": "10:30"
  }
}
```

This API design provides a comprehensive foundation for the beauty salon management system with proper authentication, validation, error handling, and multi-tenant support.

---

## P0 — Acquisition, Retention & Reactivation (Priority Zero Roadmap)

Implements 5 priority gaps from the Booksy/Treatwell gap analysis:

### Widget + QR (Phase 1)

| Method | Endpoint | Auth | Notes |
|---|---|---|---|
| GET | `/widget/instances` | JWT | List tenant widgets |
| POST | `/widget/instances` | JWT | Create (returns token once) |
| PATCH | `/widget/instances/:id` | JWT | Whitelist / theme |
| DELETE | `/widget/instances/:id` | JWT | Revoke |
| GET | `/embed/:token` | Public | Widget config + CSP `frame-ancestors` |
| GET | `/qr/salon/:slug` | Public | PNG/SVG, `Cache-Control: public, max-age=3600` |
| GET | `/qr/professional/:id` | Public | Pre-filtered agenda |
| GET | `/qr/service/:id` | Public | Pre-filtered service |

### Import CSV + ICS feeds (Phase 1)

| Method | Endpoint | Auth | Notes |
|---|---|---|---|
| POST | `/import/clients/dry-run` | JWT | Stream-parse CSV (papaparse); returns first 50 rows + stats + errors |
| POST | `/import/clients/commit` | JWT | Idempotent per `tenantId+email`; `_action=insert\|update\|skip` |
| GET | `/import/jobs` | JWT | History (last 50) |
| GET | `/import/template/clients` | JWT | CSV template + spec |
| GET | `/ics/salon/:slug?token=<hmac>` | Public | Aggregated salon feed |
| GET | `/ics/professional/:id?token=<hmac>` | Public | Per-professional feed |
| GET | `/ics/staff/:id?token=<hmac>` | Public | Per-staff feed |

ICS tokens use HMAC-SHA256(ICS_TOKEN_SECRET, scope). Supports `webcal://`.

### Consent Forms (Phase 2)

| Method | Endpoint | Auth | Notes |
|---|---|---|---|
| GET | `/consent-forms` | JWT | List per tenant |
| POST | `/consent-forms` | JWT | Create v1 |
| PATCH | `/consent-forms/:id` | JWT | **Immutable**: creates v+1, marks prior `isActive=false` |
| DELETE | `/consent-forms/:id` | JWT | Revoke form |
| GET | `/consent/required?serviceId=` | JWT | Resolve active forms for a service |
| POST | `/consent/sign` | Public (rate-limit 30/min) | Typed signature + IP hash |
| POST | `/consent/:id/revoke` | JWT | Mark consent as revoked |

When `PATCH /appointments/:id` transitions status `pending → confirmed`, server checks
required consents. If missing, returns **409** with `{ code: "CONSENT_REQUIRED",
requiredConsents: [...] }`.

### Reviews (Phase 2)

| Method | Endpoint | Auth | Notes |
|---|---|---|---|
| GET | `/reviews?rating=&status=` | JWT | Tenant list |
| POST | `/reviews/:id/moderate` | JWT | Approve / reject |
| GET | `/public/r/:token` | Public (rate-limit 60/min) | Landing for client |
| POST | `/public/r/:token` | Public (rate-limit 3/min) | Publish rating |
| GET | `/analytics/reviews?from=&to=` | JWT | Avg, distribution, top performers |

Cron `0 14 * * *` (`ReviewsService.dispatchReviewRequests`): finds appointments
`completed > 24h ago` with `reviewRequestSent=false`, generates HMAC token, persists
pending `Review`, creates in-app notification with link `/r/:token` (TTL 14 days).
Google Business uses deep-link `https://search.google.com/local/writereview?placeid=...`
(API does NOT allow creation; deep-link is the legal pattern).

### WhatsApp WABA + Broadcasts (Phase 3)

| Method | Endpoint | Auth | Notes |
|---|---|---|---|
| GET | `/whatsapp/connect/start` | JWT | Returns OAuth URL with HMAC state |
| GET | `/whatsapp/connect/callback` | Public | Code→token exchange |
| POST | `/whatsapp/connect/manual` | JWT | Sandbox/dev shortcut |
| GET | `/whatsapp/connection` | JWT | Active connection (no token leaked) |
| DELETE | `/whatsapp/connection` | JWT | Disconnect |
| GET | `/whatsapp/templates?status=APPROVED` | JWT | Synced from Meta |
| POST | `/whatsapp/campaigns` | JWT | Create draft/scheduled |
| POST | `/whatsapp/campaigns/:id/send` | JWT | Enqueue recipients |
| GET | `/whatsapp/campaigns/:id/report` | JWT | Live counters |
| GET | `/webhooks/meta/whatsapp` | Public | Hub challenge |
| POST | `/webhooks/meta/whatsapp` | Public (HMAC) | Status + inbound messages |

Tokens at rest are encrypted with `EncryptionService` (AES-256-GCM). The webhook
receiver verifies `X-Hub-Signature-256` against `META_APP_SECRET`. Routing is done
by `metadata.phone_number_id` mapped to tenant via cached in-memory index (refresh
every 5 min).

Rate limiting: token-bucket per tenant tier (`tier_1=80/sec`, `tier_2=200/sec`,
`tier_3=1000/sec`, `tier_unlimited`). Opt-out: inbound `STOP`, `UNSUBSCRIBE`,
`CANCELAR`, `BAJA` flips `WhatsAppCampaignRecipient.status='opted_out'` and clears
`Client.communicationPreferences.whatsapp`.

---

## Rate limits (P0 public endpoints)

All enforced via `@Throttle({ ttl, limit })` from `@nestjs/throttler`:

| Endpoint | TTL | Limit |
|---|---|---|
| `/embed/:token` | 60s | 60 |
| `/public/r/:token` GET | 60s | 60 |
| `/public/r/:token` POST | 60s | 3 |
| `/consent/sign` | 60s | 30 |
| `/qr/*` | 60s | 120 |
| `/ics/*` | 60s | 120 |
| `/webhooks/meta/whatsapp` POST | 1s | 50 |