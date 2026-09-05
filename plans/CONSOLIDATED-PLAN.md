# KiraRoom SaaS - Consolidated Development Plan

**Single Source of Truth**  
**Version:** 1.1 (Corrected)  
**Created:** 2026-01-06  
**Updated:** 2026-01-06  
**Architecture:** NestJS + Next.js 14 + Prisma + PostgreSQL + Docker

---

## Executive Summary

KiraRoom is a beauty salon management SaaS platform. This plan consolidates all previous planning documents into a single actionable roadmap.

### Current Status: BLOCKED âš ï¸

The project has ~70% infrastructure complete but has **critical blockers** preventing progress:

| Blocker | Impact | Priority |
|---------|--------|----------|
| PostgreSQL not connected | No database operations | CRITICAL |
| TypeScript compilation errors | Cannot build backend | CRITICAL |
| Prisma migration not applied | Schema not deployed | HIGH |
| No auth | Cannot test full system flows | HIGH |

---

## Technology Stack

### Frontend
- **Framework:** Next.js 14+ with React 18
- **Language:** TypeScript
- **Styling:** Tailwind CSS
- **UI Components:** shadcn/ui (built on Radix UI primitives)
- **State Management:** TanStack React Query
- **Forms:** React Hook Form + Zod

### Backend
- **Framework:** NestJS (Node.js)
- **Language:** TypeScript
- **Database:** PostgreSQL + Prisma ORM
- **Authentication:** JWT with Passport

### Infrastructure
- **Container:** Docker + Docker Compose
- **Runtime:** Node.js 18+
- **Package Manager:** npm

---

## Phased Implementation Plan

### Phase 1: Resolve Blockers (Week 1)

#### 1.1 Database Connection Setup

**Goal:** Establish PostgreSQL connection and apply migrations

**Tasks:**
- [ ] Configure `.env` with `DATABASE_URL`
- [ ] Start PostgreSQL via Docker: `docker-compose up -d postgres`
- [ ] Verify container running: `docker ps`
- [ ] Apply Prisma migration: `npx prisma migrate dev`
- [ ] Generate Prisma client: `npx prisma generate`
- [ ] Test connection with: `npx prisma db push`

**Verification:**
```bash
# Should output connected
npx prisma db ping
```

**Environment Variables Required:**
```bash
# packages/backend/.env
DATABASE_URL="postgresql://kiraroom:kiraroom123@localhost:5432/kiraroom"
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:3000
```

#### 1.2 TypeScript Compilation Fixes

**Goal:** Resolve all TypeScript errors in backend services

**Tasks:**
- [ ] Run `cd packages/backend && npm run build` to identify errors
- [ ] Fix Prisma client imports in all service files
- [ ] Update enum imports from `@prisma/client`
- [ ] Fix interface mismatches with Prisma schema
- [ ] Verify clean build with `tsc --noEmit`

**Common Issues to Check:**
- `appointments.service.ts` - Prisma types usage
- `auth.service.ts` - Password hashing imports
- All DTOs - Match Prisma schema field types

#### 1.3 Backend Service Migration Completion

**Goal:** Complete migration from TypeORM patterns to Prisma

**Tasks:**
- [ ] Audit `src/**/*service.ts` for TypeORM `@Repository` imports
- [ ] Replace with `private prisma = new PrismaClient()`
- [ ] Update `find`, `findOne`, `save` patterns to Prisma syntax
- [ ] Add proper error handling with `Prisma.PrismaClientKnownRequestError`

**Code Pattern to Use:**
```typescript
// BEFORE (TypeORM)
const user = await this.userRepository.findOne({
  where: { id: userId },
  relations: ['appointments']
});

// AFTER (Prisma)
const user = await this.prisma.user.findUnique({
  where: { id: userId },
  include: { appointments: true }
});
```

---

### Phase 2: Core Features (Week 2)

#### 2.1 Authentication System

**Goal:** Implement JWT-based auth with multi-tenant support

**API Endpoints:**
```
POST   /api/v1/auth/register     - Create tenant + owner account
POST   /api/v1/auth/login        - Login and get tokens
POST   /api/v1/auth/refresh      - Refresh access token
POST   /api/v1/auth/logout       - Invalidate tokens
POST   /api/v1/auth/forgot-password
POST   /api/v1/auth/reset-password
```

**Tasks:**
- [ ] Create `auth.service.ts` with JWT token generation
- [ ] Create `jwt.strategy.ts` for Passport authentication
- [ ] Create `jwt-auth.guard.ts` for protected routes
- [ ] Implement password hashing with `bcrypt`
- [ ] Add role-based access control (owner, admin, staff, client)
- [ ] Configure JWT expiration (access: 15min, refresh: 7 days)

**JWT Payload:**
```typescript
interface JwtPayload {
  sub: string;      // userId
  email: string;
  role: UserRole;
  tenantId: string;
  iat?: number;
  exp?: number;
}
```

#### 2.2 API Integration Testing

**Goal:** Verify frontend-backend connectivity

**Tasks:**
- [ ] Test `/api/v1/services` returns services list
- [ ] Test `/api/v1/professionals` returns staff list
- [ ] Test `/api/v1/appointments` with auth token
- [ ] Verify frontend `lib/api.ts` points to correct URL
- [ ] Test complete booking flow end-to-end

---

### Phase 3: Notifications & Admin (Week 3)

#### 3.1 Notification System

**Goal:** Multi-channel notification system

**Architecture:**
```
Appointment Event â†’ NotificationService
                         â†“
        â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
        â†“                â†“                â†“
   EmailService      SMSService    WhatsAppService
        â†“                â†“                â†“
     SMTP            Twilio       WhatsApp API
```

**Notification Types:**
- [ ] Booking confirmation (email + SMS)
- [ ] Appointment reminder (24h, 2h before)
- [ ] Cancellation notice
- [ ] Welcome email for new clients

**Tasks:**
- [ ] Create `notification.service.ts`
- [ ] Implement email with Nodemailer
- [ ] Integrate Twilio for SMS
- [ ] Add notification queue (in-memory for MVP, Redis later)
- [ ] Create email templates

#### 3.2 Admin Dashboard Features

**Goal:** Core admin functionality

**Features:**
- [ ] Client management (CRUD)
- [ ] Professional management (CRUD)
- [ ] Service catalog (CRUD)
- [ ] Appointment calendar view
- [ ] Basic analytics (daily stats, occupancy)

---

### Phase 4: Quality & Deployment (Week 4)

#### 4.1 Testing

**Tasks:**
- [ ] Unit tests for services (Jest) - target 70% coverage
- [ ] Integration tests for API endpoints
- [ ] E2E test for booking flow (Cypress)

#### 4.2 Production Deployment

**Tasks:**
- [ ] Create production Dockerfile
- [ ] Configure Docker Compose for production
- [ ] Set up nginx reverse proxy
- [ ] Configure SSL with Let's Encrypt
- [ ] Set up CI/CD with GitHub Actions

---

## Success Criteria

### Phaseers Res 1 (Blockolved)
- [ ] `npm run build` completes without errors
- [ ] Database tables created: `tenants`, `users`, `clients`, `services`, `professionals`, `appointments`
- [ ] Backend starts: `curl http://localhost:3001/api/v1/health`
- [ ] Frontend can reach backend API

### Phase 2 (Core Features)
- [ ] User registration creates tenant + owner
- [ ] Login returns valid JWT token
- [ ] Protected endpoints require authentication
- [ ] Can create and retrieve appointments

### Phase 3 (Notifications & Admin)
- [ ] Email notifications send successfully
- [ ] SMS notifications via Twilio work
- [ ] Admin dashboard loads all sections
- [ ] CRUD operations work for all entities

### Phase 4 (Production Ready)
- [ ] 70%+ test coverage
- [ ] Docker images build successfully
- [ ] HTTPS working on production domain
- [ ] Monitoring endpoints active

---

## Environment Configuration

### Development Environment
```bash
# Required tools
- Node.js 18+
- Docker Desktop
- PostgreSQL 15+ (via Docker)
- Git

# Start services
cd packages/backend
docker-compose up -d
npm run dev:watch
```

### Environment Variables
```bash
# packages/backend/.env
DATABASE_URL="postgresql://kiraroom:kiraroom123@localhost:5432/kiraroom"
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:3000

# Authentication
JWT_SECRET="your-secure-secret-key-min-32-chars"
JWT_EXPIRES_IN="7d"
JWT_REFRESH_SECRET="your-refresh-secret-key"
JWT_REFRESH_EXPIRES_IN="30d"

# Email (for notifications)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# SMS (Twilio)
TWILIO_ACCOUNT_SID=your-sid
TWILIO_AUTH_TOKEN=your-token
TWILIO_PHONE_NUMBER=+1234567890

# WhatsApp (Meta)
WHATSAPP_TOKEN=your-whatsapp-token
WHATSAPP_PHONE_ID=your-phone-id
```

---

## Docker Services

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: kiraroom
      POSTGRES_USER: kiraroom
      POSTGRES_PASSWORD: kiraroom123
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  postgres_data:
```

---

## Deployment Checklist

### Pre-Deployment
- [ ] All tests pass
- [ ] Build succeeds locally
- [ ] Environment variables set on server
- [ ] SSL certificate obtained
- [ ] Domain DNS points to server

### Deployment Steps
- [ ] SSH into server
- [ ] Clone repository
- [ ] Run `docker-compose pull`
- [ ] Run `docker-compose up -d`
- [ ] Verify containers running: `docker-compose ps`
- [ ] Check logs: `docker-compose logs -f`
- [ ] Test health endpoint: `curl https://api.kiraroom.com/health`

### Post-Deployment
- [ ] Verify database migrations applied
- [ ] Check API endpoints responding
- [ ] Monitor error logs for 24 hours
- [ ] Set up backup cron job
- [ ] Configure monitoring alerts

---

## API Documentation

### Base URL
```
Development: http://localhost:3001/api/v1
Production:  https://api.kiraroom.com/api/v1
```

### Endpoints

**Auth:**
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /auth/register | Register new tenant + owner |
| POST | /auth/login | Login and get tokens |
| POST | /auth/refresh | Refresh access token |
| POST | /auth/logout | Logout |
| POST | /auth/forgot-password | Request password reset |
| POST | /auth/reset-password | Reset password |

**Appointments:**
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /appointments | List appointments |
| POST | /appointments | Create appointment |
| GET | /appointments/:id | Get appointment |
| PATCH | /appointments/:id | Update appointment |
| DELETE | /appointments/:id | Cancel appointment |
| GET | /appointments/available-slots | Get available slots |

**Services:**
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /services | List services |
| POST | /services | Create service |
| GET | /services/:id | Get service |
| PATCH | /services/:id | Update service |
| DELETE | /services/:id | Delete service |

**Professionals:**
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /professionals | List professionals |
| POST | /professionals | Create professional |
| GET | /professionals/:id | Get professional |
| PATCH | /professionals/:id | Update professional |
| DELETE | /professionals/:id | Delete professional |

**Clients:**
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /clients | List clients |
| POST | /clients | Create client |
| GET | /clients/:id | Get client |
| PATCH | /clients/:id | Update client |
| DELETE | /clients/:id | Delete client |

**Salon:**
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /salon | Get salon settings |
| PATCH | /salon | Update salon settings |

---

## Performance Targets

| Metric | Target |
|--------|--------|
| API response time (auth) | < 200ms |
| API response time (CRUD) | < 300ms |
| API response time (complex) | < 500ms |
| Frontend page load | < 3s |
| Database simple query | < 50ms |
| Uptime | 99.5% |

---

## Document References

This plan supersedes:
- `plans/saas-beauty-platform-plan.md`
- `plans/Plan-Completo-Final.md`
- `plans/kira-room-mvp-roadmap.md`

**Active Reference Documents:**
- `docs/development-continuation-plan.md` - Historical context
- `docs/database-schema.md` - Database design
- `docs/api-design.md` - API specifications

---

## Next Action

**Immediate (Today):**
1. Run `docker-compose up -d postgres` to start PostgreSQL
2. Apply Prisma migration: `cd packages/backend && npx prisma migrate dev`
3. Run build to identify TypeScript errors: `cd packages/backend && npm run build`

**This Week:**
- Resolve all blockers from Phase 1
- Implement authentication system
- Test end-to-end booking flow

---

## Pending issues (post Plan v2)

Tras cerrar las 12 fases del plan v2 (Fase 0 → 12), varios items
quedaron abiertos (funcionalidades no cableadas, polish UI, deuda
de tests). La lista viva está en:

**`.kilo/plans/plan-v2-pending-issues.md`**

Categorías:
- **HIGH**: H-1..H-6 — funcionalidades que faltan para que el producto
  haga lo que el plan v2 promete.
- **MEDIUM**: M-1..M-2 — polish UX, observabilidad.
- **LOW**: L-1..L-7 — infraestructura de tests, dev tooling, dashboards.

Regla operativa: al retomar el trabajo, abrir el archivo de issues y
atender primero los HIGH. Al cerrar uno, moverlo a "Issues cerrados"
con la fecha y el commit.