# Database Schema Design - Kira Studio

## Overview

Multi-tenant PostgreSQL database schema designed for beauty salon management system. All tables include `tenant_id` for multi-tenant support with row-level security.

## Core Entities

### 1. Tenants (Salons)
```sql
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL, -- For subdomain/custom domain
    description TEXT,
    logo VARCHAR(500),
    cover_image VARCHAR(500),
    website VARCHAR(255),
    
    -- Contact Information
    email VARCHAR(255),
    phone VARCHAR(50),
    whatsapp VARCHAR(50),
    
    -- Address
    street VARCHAR(255),
    city VARCHAR(100),
    state VARCHAR(100),
    postal_code VARCHAR(20),
    country VARCHAR(2) DEFAULT 'ES',
    
    -- Business Settings
    timezone VARCHAR(50) DEFAULT 'Europe/Madrid',
    currency VARCHAR(3) DEFAULT 'EUR',
    language VARCHAR(5) DEFAULT 'es',
    date_format VARCHAR(20) DEFAULT 'DD/MM/YYYY',
    time_format VARCHAR(5) DEFAULT '24h',
    
    -- Subscription
    plan VARCHAR(20) NOT NULL CHECK (plan IN ('basic', 'professional', 'advanced')),
    subscription_status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (subscription_status IN ('active', 'cancelled', 'past_due', 'trialing')),
    current_period_start TIMESTAMP NOT NULL,
    current_period_end TIMESTAMP NOT NULL,
    trial_end TIMESTAMP,
    stripe_customer_id VARCHAR(255),
    stripe_subscription_id VARCHAR(255),
    
    -- Features
    features JSONB DEFAULT '{}',
    
    -- Timestamps
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### 2. Users
```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('owner', 'admin', 'staff', 'client')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_email_verified BOOLEAN NOT NULL DEFAULT false,
    
    -- Authentication
    password_hash VARCHAR(255) NOT NULL,
    last_login_at TIMESTAMP,
    profile_image VARCHAR(500),
    phone VARCHAR(50),
    
    -- Two-Factor Authentication
    two_factor_enabled BOOLEAN NOT NULL DEFAULT false,
    two_factor_secret VARCHAR(32),
    
    -- Security
    login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TIMESTAMP,
    password_reset_token VARCHAR(255),
    password_reset_expires TIMESTAMP,
    email_verification_token VARCHAR(255),
    email_verification_expires TIMESTAMP,
    
    -- Preferences
    preferences JSONB DEFAULT '{}',
    permissions JSONB DEFAULT '{}',
    
    -- Timestamps
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(tenant_id, email)
);
```

### 3. Clients
```sql
CREATE TABLE clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(50),
    date_of_birth DATE,
    gender VARCHAR(20) CHECK (gender IN ('male', 'female', 'other', 'prefer_not_to_say')),
    profile_image VARCHAR(500),
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'blocked')),
    
    -- Preferences
    preferred_language VARCHAR(5) DEFAULT 'es',
    preferred_services JSONB DEFAULT '[]',
    preferred_professionals JSONB DEFAULT '[]',
    preferred_times JSONB DEFAULT '{}',
    communication_preferences JSONB DEFAULT '{}',
    
    -- Loyalty Program
    loyalty_points INTEGER NOT NULL DEFAULT 0,
    loyalty_tier VARCHAR(20) DEFAULT 'bronze' CHECK (loyalty_tier IN ('bronze', 'silver', 'gold', 'platinum')),
    
    -- Statistics
    total_spent DECIMAL(10,2) NOT NULL DEFAULT 0,
    visit_count INTEGER NOT NULL DEFAULT 0,
    average_spent DECIMAL(10,2) NOT NULL DEFAULT 0,
    first_visit TIMESTAMP NOT NULL,
    last_visit TIMESTAMP,
    
    -- Additional Information
    source VARCHAR(100), -- How they found the salon
    allergies JSONB DEFAULT '[]',
    medical_conditions JSONB DEFAULT '[]',
    notes TEXT,
    tags JSONB DEFAULT '[]',
    
    -- Timestamps
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(tenant_id, email)
);
```

### 4. Services
```sql
CREATE TABLE services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(50) NOT NULL CHECK (category IN ('hair', 'nails', 'facial', 'massage', 'body', 'other')),
    duration INTEGER NOT NULL, -- Duration in minutes
    price DECIMAL(10,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'EUR',
    is_active BOOLEAN NOT NULL DEFAULT true,
    requires_approval BOOLEAN NOT NULL DEFAULT false,
    max_advance_booking INTEGER DEFAULT 30, -- Days in advance
    min_advance_booking INTEGER DEFAULT 2, -- Hours in advance
    buffer_time INTEGER DEFAULT 15, -- Minutes after service
    is_online_bookable BOOLEAN NOT NULL DEFAULT true,
    is_mobile BOOLEAN NOT NULL DEFAULT false, -- Service can be done at client's location
    
    -- Additional Information
    images JSONB DEFAULT '[]',
    prerequisites JSONB DEFAULT '[]',
    staff JSONB DEFAULT '[]', -- Staff IDs who can perform this service
    equipment JSONB DEFAULT '[]',
    products JSONB DEFAULT '[]', -- Products used in this service
    tags JSONB DEFAULT '[]',
    
    -- SEO
    seo_title VARCHAR(255),
    seo_description TEXT,
    
    -- Timestamps
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### 5. Professionals (Staff)
```sql
CREATE TABLE professionals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    profile_image VARCHAR(500),
    bio TEXT,
    specialties JSONB DEFAULT '[]',
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_owner BOOLEAN NOT NULL DEFAULT false,
    position VARCHAR(100),
    commission_rate DECIMAL(5,2), -- Percentage commission
    hire_date DATE NOT NULL,
    termination_date DATE,
    
    -- Working Hours
    working_hours JSONB NOT NULL DEFAULT '[]',
    
    -- Availability
    availability JSONB DEFAULT '{}',
    
    -- Settings
    settings JSONB DEFAULT '{}',
    
    -- Statistics
    stats JSONB DEFAULT '{}',
    
    -- Timestamps
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(tenant_id, email)
);
```

### 6. Appointments
```sql
CREATE TABLE appointments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    -- Relationships
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    professional_id UUID NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
    
    -- Scheduling
    scheduled_date DATE NOT NULL,
    scheduled_time TIME NOT NULL,
    duration INTEGER NOT NULL, -- Duration in minutes
    end_time TIME NOT NULL,
    
    -- Status
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show')),
    
    -- Pricing
    price DECIMAL(10,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'EUR',
    payment_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),
    payment_method VARCHAR(50),
    stripe_payment_intent_id VARCHAR(255),
    
    -- Additional Information
    notes TEXT,
    internal_notes TEXT,
    cancellation_reason TEXT,
    cancellation_policy VARCHAR(255),
    
    -- Recurring
    is_recurring BOOLEAN NOT NULL DEFAULT false,
    recurring_series_id UUID,
    parent_appointment_id UUID REFERENCES appointments(id),
    
    -- Reminders
    reminders JSONB DEFAULT '[]',
    
    -- Timing
    check_in_time TIMESTAMP,
    start_time TIMESTAMP,
    completion_time TIMESTAMP,
    
    -- Add-ons and Modifications
    addons JSONB DEFAULT '[]',
    discount JSONB DEFAULT '{}',
    taxes JSONB DEFAULT '[]',
    total_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
    amount_paid DECIMAL(10,2) NOT NULL DEFAULT 0,
    amount_due DECIMAL(10,2) NOT NULL DEFAULT 0,
    
    -- Source
    source VARCHAR(50) NOT NULL DEFAULT 'online' CHECK (source IN ('online', 'phone', 'walk_in', 'staff', 'widget', 'instagram')),
    utm_source VARCHAR(100),
    utm_medium VARCHAR(100),
    utm_campaign VARCHAR(100),
    
    -- Feedback
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    review TEXT,
    feedback JSONB DEFAULT '{}',
    
    -- Location
    location VARCHAR(20) NOT NULL DEFAULT 'salon' CHECK (location IN ('salon', 'client_home', 'other')),
    address TEXT,
    travel_fee DECIMAL(10,2) DEFAULT 0,
    
    -- Deposit
    deposit_required BOOLEAN NOT NULL DEFAULT false,
    deposit_amount DECIMAL(10,2),
    deposit_paid BOOLEAN NOT NULL DEFAULT false,
    deposit_payment_intent_id VARCHAR(255),
    
    -- Timestamps
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

## Supporting Tables

### 7. Client Notes
```sql
CREATE TABLE client_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    is_private BOOLEAN NOT NULL DEFAULT true,
    tags JSONB DEFAULT '[]',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### 8. Working Hours Templates
```sql
CREATE TABLE working_hours_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    schedule JSONB NOT NULL, -- Weekly schedule template
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### 9. Blocked Time Slots
```sql
CREATE TABLE blocked_slots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    professional_id UUID REFERENCES professionals(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    reason VARCHAR(255),
    type VARCHAR(20) NOT NULL CHECK (type IN ('vacation', 'break', 'meeting', 'personal', 'maintenance')),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### 10. Notifications
```sql
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    recipient_id UUID NOT NULL, -- Can be user_id or client_id
    recipient_type VARCHAR(20) NOT NULL CHECK (recipient_type IN ('user', 'client')),
    type VARCHAR(50) NOT NULL,
    channel VARCHAR(20) NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'push')),
    subject VARCHAR(255),
    content TEXT NOT NULL,
    data JSONB DEFAULT '{}',
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'delivered')),
    sent_at TIMESTAMP,
    error_message TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

## Indexes for Performance

```sql
-- Tenant-based queries
CREATE INDEX idx_appointments_tenant_date ON appointments(tenant_id, scheduled_date);
CREATE INDEX idx_appointments_tenant_professional ON appointments(tenant_id, professional_id, scheduled_date);
CREATE INDEX idx_appointments_tenant_client ON appointments(tenant_id, client_id);
CREATE INDEX idx_clients_tenant_email ON clients(tenant_id, email);
CREATE INDEX idx_clients_tenant_phone ON clients(tenant_id, phone);
CREATE INDEX idx_services_tenant_active ON services(tenant_id, is_active);
CREATE INDEX idx_professionals_tenant_active ON professionals(tenant_id, is_active);

-- Status-based queries
CREATE INDEX idx_appointments_status ON appointments(status);
CREATE INDEX idx_appointments_payment_status ON appointments(payment_status);
CREATE INDEX idx_tenants_subscription_status ON tenants(subscription_status);

-- Date range queries
CREATE INDEX idx_appointments_date_range ON appointments(scheduled_date, scheduled_time);
CREATE INDEX idx_professionals_availability ON blocked_slots(date, professional_id);

-- Search indexes
CREATE INDEX idx_clients_search ON clients USING gin(to_tsvector('spanish', first_name || ' ' || last_name || ' ' || COALESCE(email, '')));
CREATE INDEX idx_services_search ON services USING gin(to_tsvector('spanish', name || ' ' || COALESCE(description, '')));
```

## Row Level Security (RLS)

```sql
-- Enable RLS for all tables
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE professionals ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE working_hours_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Create policies for tenant isolation
CREATE POLICY tenant_isolation ON tenants FOR ALL USING (id = current_setting('app.current_tenant_id')::uuid);
CREATE POLICY tenant_isolation ON users FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
CREATE POLICY tenant_isolation ON clients FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
CREATE POLICY tenant_isolation ON services FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
CREATE POLICY tenant_isolation ON professionals FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
CREATE POLICY tenant_isolation ON appointments FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
CREATE POLICY tenant_isolation ON client_notes FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
CREATE POLICY tenant_isolation ON working_hours_templates FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
CREATE POLICY tenant_isolation ON blocked_slots FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
CREATE POLICY tenant_isolation ON notifications FOR ALL USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

## Database Functions

```sql
-- Function to set tenant context
CREATE OR REPLACE FUNCTION set_tenant_context(tenant_uuid UUID)
RETURNS VOID AS $$
BEGIN
    PERFORM set_config('app.current_tenant_id', tenant_uuid::text, true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get appointment slots for a date
CREATE OR REPLACE FUNCTION get_available_slots(
    tenant_uuid UUID,
    professional_uuid UUID,
    service_uuid UUID,
    target_date DATE
)
RETURNS TABLE(
    slot_time TIME,
    is_available BOOLEAN
) AS $$
DECLARE
    service_duration INTEGER;
    working_hours JSONB;
    blocked_slots_data JSONB;
BEGIN
    -- Get service duration
    SELECT duration INTO service_duration 
    FROM services 
    WHERE id = service_uuid AND tenant_id = tenant_uuid;
    
    -- Get professional working hours for the day
    SELECT working_hours INTO working_hours
    FROM professionals 
    WHERE id = professional_uuid AND tenant_id = tenant_uuid;
    
    -- Get blocked slots for the date
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'start_time', start_time,
        'end_time', end_time
    )), '[]'::jsonb) INTO blocked_slots_data
    FROM blocked_slots 
    WHERE professional_id = professional_uuid AND date = target_date;
    
    -- Implementation would generate time slots based on working hours
    -- and subtract blocked slots and existing appointments
    
    RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

## Data Relationships

```
tenants (1) ----< (N) users
tenants (1) ----< (N) clients
tenants (1) ----< (N) services
tenants (1) ----< (N) professionals
tenants (1) ----< (N) appointments

clients (1) ----< (N) appointments
services (1) ----< (N) appointments
professionals (1) ----< (N) appointments
appointments (1) ----< (N) client_notes

professionals (1) ----< (N) blocked_slots
tenants (1) ----< (N) working_hours_templates
```

## Migration Strategy

1. **Initial Setup**: Create base tables with core functionality
2. **Phase 1**: Add indexes and RLS policies
3. **Phase 2**: Add advanced features and constraints
4. **Phase 3**: Add triggers and database functions
5. **Phase 4**: Performance optimization and partitioning if needed

## P0 — Priority Zero additions (migration `20260715000000_priority_zero_init`)

Additive only. No existing table modified beyond a new nullable FK and indexes.

```
tenants (1) ----< (N) widget_instances
tenants (1) ----< (N) import_jobs
tenants (1) ----< (N) consent_forms
tenants (1) ----< (N) consents
tenants (1) ----< (N) reviews
tenants (1) ----< (1) whatsapp_connections
tenants (1) ----< (N) whatsapp_campaigns

widget_instances (1) ----< (N) appointments    -- attribution (nullable FK)
consent_forms (1) ----< (N) consents           -- with immutable formSnapshot
whatsapp_campaigns (1) ----< (N) whatsapp_campaign_recipients

appointments.widgetInstanceId → widget_instances.id (onDelete SetNull)
```

### Enums added

- `ImportType`: clients | services | professionals
- `ImportStatus`: pending | processing | completed | failed
- `ReviewSource`: email_link | whatsapp_link | qr | in_person | public_page | widget
- `ReviewStatus`: pending | moderation | published | rejected
- `WhatsAppCampaignStatus`: draft | scheduled | sending | completed | failed | cancelled
- `WhatsAppRecipientStatus`: pending | sent | delivered | read | failed | opted_out | invalid

### Index highlights

- `widget_instances.token` UNIQUE — public widget lookup by token
- `consent_forms(tenantId, serviceIds)` GIN-style — resolve forms per service
- `consents(clientId)` + `(formId)` + `(appointmentId)` — fast validation gates
- `reviews(appointmentId)` UNIQUE — one review per appointment
- `whatsapp_campaign_recipients(campaignId)` + `(status)` — campaign analytics
- `whatsapp_connections(phoneNumberId)` — webhook routing

### Append-only invariants

- `Consent` rows are never updated except for `revokedAt` / `revokeReason`; signatures stay immutable for RGPD (6-year retention).
- `ConsentForm.version` increments via PATCH — the original is kept with `isActive=false` and any `Consent.formSnapshot` continues to point to the form state the client signed.
- `Appointment.rating` / `.review` legacy columns remain until deprecation (6-month window) but new reviews go to `Review` table.

This schema provides a solid foundation for the beauty salon management system with proper multi-tenant isolation, performance optimization, and extensibility for future features.

## P1.3 + P1.4 — Onboarding wizard + Rebooking cadence (migration `20260715100000_priority_one_onboarding_rebooking`)

### New tables

- **`onboarding_states`** — one row per tenant. Stores `currentStep`, `steps` JSON map (`{stepKey: {status, completedAt?, skippedAt?, dismissedAt?}}`), `checklistDismissed`, `finishedAt`. Cascade on tenant delete.
- **`onboarding_step_defs`** — global catalog of wizard steps. Tenant-independent; seeded idempotently at boot via `OnboardingStepSeeder`. Columns: `key`, `order` (unique), `group` (enum), `titleI18nKey`, `descI18nKey`, `href`, `detectName`, `defaultOrder`, `enabled`.
- **`client_cadences`** — one row per client. `byService` JSON map keyed by `serviceId` with `{avgDays, stdDevDays, lastVisit, visitsCount, nextExpectedAt}`. `nextRecommendedReminderAt` is the global recommendation. Indexed on `tenantId` and `nextRecommendedReminderAt`.
- **`rebooking_reminders`** — individual reminders dispatched by the cron worker. `serviceId` nullable for generic reminders. Indexed on `[tenantId, scheduledAt]` and `[clientId, status]`.

### Enums added

- `OnboardingGroup { linear_required, linear_optional, checklist_optional }`
- `RebookChannel { email, whatsapp, both }`
- `RebookStatus { scheduled, sent, cancelled, failed, booked }`

### Tenant.rebookingSettings

JSON field on `Tenant` with shape `{ enabled: boolean, leadDays: 1-7, channelFallback: 'email'|'whatsapp'|'both', minVisits: 1-10 }`. Default: `{ enabled: false, leadDays: 3, channelFallback: 'both', minVisits: 3 }`. Disabled by default for new accounts — owners opt-in via `/dashboard/settings/rebooking`.

### Index highlights

- `client_cadences(nextRecommendedReminderAt)` — makes the hourly cron tick a single index scan.
- `rebooking_reminders(tenantId, scheduledAt)` — used by the cancellation flow that looks up recent reminders for a (client, service) pair.
- `rebooking_reminders(clientId, status)` — used by the per-client log endpoint.

### Backfill

Run once after deploy: `npx ts-node scripts/backfill-priority-one.ts` from `packages/backend`. The script ensures every tenant has an `OnboardingState` row and reports how many clients are eligible for cadence computation (the runtime cron picks them up).

## P2A — Fiscal España (migration `20260716130000_priority_two_fiscal_spain`)

Cubre el cumplimiento fiscal español: Verifactu (Real Decreto 1007/2023, nacional), TicketBAI (País Vasco, 3 diputaciones) y SII (Suministro Inmediato de Información, IVA en tiempo real). El plan completo está en `~/.local/share/kilo/plans/1784133600001-priority-two-fiscal-accounting.md`.

### New tables

- **`invoices`** — una fila por factura emitida. Almacena importes en céntimos, `taxBreakdown` JSON con desglose por tipo IVA, `fiscalMode`/`fiscalStatus` para el estado de envío a AEAT/diputación, `fiscalXml` con el envelope firmado XAdES-BES, `fiscalQrUrl` para Verifactu, `fiscalReference` con el justificante CSV/TBAI/SII. Unique `(tenantId, series, number)` garantiza numeración correlativa.
- **`invoice_lines`** — líneas de factura con `productId`/`serviceId`/`appointmentId` para trazabilidad origen.
- **`fiscal_certificates`** — certificados digitales cifrados en reposo (`encryptedPem`, `passphraseCipher` opcional). Solo se almacena `fingerprint` (SHA-256) del cert público en claro para búsqueda. Indexado por `(tenantId, isActive)`.
- **`fiscal_sequences`** — contador atómico de numeración correlativa. Unique `(tenantId, series, year)`.

### Enums añadidos

- `InvoiceRecipient { client | tenant }` — sujeto de la factura.
- `InvoiceStatus { draft | issued | paid | cancelled | refunded }`.
- `InvoiceFiscalStatus { not_required | pending | accepted | rejected | error }`.
- `InvoiceSource { order | appointment | manual | subscription }` — origen del documento.
- `FiscalMode { none | verifactu | ticketbai | sii_only }` — régimen del tenant.
- `FiscalCertProvider { p12 | cloud_dnie }`.

### Tenant fields

- `fiscalMode FiscalMode @default(none)` — régimen fiscal del tenant (qué pipeline usar al emitir).
- `fiscalSettings Json` — `{ defaultSeries, defaultTaxRate, autoInvoiceAppointments, diputacion }`. `autoInvoiceAppointments=true` activa la generación automática de factura al completar una cita.

### Pipeline de emisión

1. `InvoiceService.create()` calcula totales vía `InvoiceCalculator` (redondeo half-even por línea, desglose por tipo IVA), asigna el siguiente correlativo vía `FiscalSequence` (incremento atómico con `update ... data: { lastNumber: { increment: 1 } }`), persiste con `status='issued'` y `fiscalStatus='pending'` (o `not_required` si `fiscalMode='none'`).
2. Si `fiscalMode!='none'`, se dispara `FiscalService.dispatchInvoice()` en background (no bloquea la respuesta HTTP).
3. `FiscalService` enruta a VerifactuService / TicketBaiService / SiiService según `fiscalMode`.
4. Cada provider: (a) construye el envelope XML según el esquema oficial, (b) firma con `XadesService.sign()` (stub), (c) envía vía HTTP/SOAP (stub), (d) persiste el resultado en `Invoice.fiscalStatus` + `fiscalReference` + `fiscalError` + `fiscalSubmittedAt`.

### Auto-emisión

- `AppointmentsService.complete()` llama a `InvoiceService.fromAppointment()` tras marcar la cita como completada. Solo emite si `fiscalSettings.autoInvoiceAppointments=true`.
- `POST /invoices/from-order/:orderId` permite generar factura manualmente desde un pedido POS pagado.

### Estado del firmador (importante para producción)

`XadesService` y los transports HTTP de Verifactu/TicketBAI/SII son STUBS. El XML producido contiene la estructura `<ds:Signature>` correcta y los desgloses de IVA según el esquema AEAT, pero el `SignatureValue` y el hash del documento no están firmados criptográficamente con el certificado del tenant. Para activar envío real a AEAT:

1. `npm install xml-crypto node-forge`
2. Sustituir `XadesService.sign()` con `node-forge` para descifrar PKCS#12 + `xml-crypto.SignedXml` para producir XAdES-BES real.
3. Sustituir `_postToAeat()` / `_postToDeputacion()` / `_postSoap()` con las URLs reales:
   - `process.env.AEAT_VERIFACTU_ENDPOINT`
   - `https://www.batuz.eus/qqtbai/api/v1/recepcion` (Bizkaia)
   - `https://tbai.gipuzkoa.eus/qrattbai/api/v1/recepcion`
   - `https://tbai.araba.eus/qrattbai/api/v1/recepcion`
   - `process.env.AEAT_SII_ENDPOINT` (SOAP WSSecurity)

El resto del pipeline (numeración, cálculo, persistencia, retry, frontend) funciona ya en producción.

## P1+ — Production-fiscal hardening (extension of P2A)

Adds the schema and pipeline elements required for AEAT / TicketBAI compliance in production. Companion to the
`20260716200000_fiscal_chain_nif_fields` migration.

### New tables

- **`fiscal_chain_states`** — one row per (tenantId, fiscalMode). Tracks the
  `lastHash`, `lastNumber`, `lastSubmittedAt` of the chain so each
  submission can compute the `<HuellaAnterior>` per AEAT Verifactu spec.
  Composite primary key `(tenantId, fiscalMode)` lets one tenant run
  Verifactu and SII in parallel without crossing chains.
- **`fiscal_certificates`** — already existed; replaced its payload from
  `encryptedPem` (PEM) to **encrypted PKCS#12** (DER) + `passphraseCipher`.
  `fingerprint` is SHA-256 of the **public certificate** so duplicate
  uploads are caught without exposing the private key.

### New enums

- `NifType { nif | cif | nie | passport | other }`
- `InvoiceAccountingStatus { not_synced | pending | synced | error }`

### New fields

- **`Tenant.taxId String?`, `taxIdType NifType?`, `legalName String?`** —
  emitter NIF/CIF/NIE. Required when `fiscalMode != 'none'`; used to
  build the AEAT `<Verifactu>` and TicketBAI emitter block.
- **`Invoice`**:
  - `fiscalRetryCount Int @default(0)` — counter for the in-process
    FiscalRetryQueue (5min/30min/2h backoff).
  - `issuerTaxIdAtIssue String?` — snapshot of `Tenant.taxId` at the moment
    of issuance. Used for refund flows so subsequent changes to the
    tenant's tax identity don't rewrite history.
- **`Client.taxId String?`, `taxIdType NifType?`** — recipient tax
  identity. Validated by `validateNif()` on create/update.

### NIF validation

`packages/backend/src/common/validation/nif.validator.ts` verifies the three
canonical Spanish tax-id formats:

  - **NIF**: `^[A-Z]?\d{8}[A-Z]$` with modulo-23 letter check.
  - **NIE**: `^[XYZ]\d{7}[A-Z]$` after substituting X→0, Y→1, Z→2.
  - **CIF**: letter from the legal-entity alphabet + 7 digits + control.

10 unit tests cover valid, invalid, normalized, garbage, length edge
cases. See `nif.validator.spec.ts`.

### Hash chain

`fiscal.service.ts` builds each `<Huella>` with strict field order
(NIF → numserie → fecha → cuota → importe → huellaAnterior) and SHA-256.
Same algorithm applies for Verifactu and TicketBAI (the `&` vs `|`
separator differs by spec; both helpers exported as `buildVerifactuHuella`
and `buildTicketBaiHuella`). 7 chain-test cases verify determinism,
monotonicity across calls, and reproducibility.

### Retry queue

`fiscal-retry.queue.ts` provides in-process retries with backoff
`5min → 30min → 2h`. After 3 attempts an `email` job is queued via
`NotificationQueue` and the invoice is marked `fiscalStatus='error'` + an
email is sent to the tenant owner. Only **5xx / network errors** are
retried; 4xx validation errors fall through to permanent. 4 unit tests
cover the classifier.

## P2A — Fiscal Spain (migration `20260715100000_priority_two_fiscal_spain`)

## P2B — Integración contable (migration `20260716140000_priority_two_accounting` + `20260716140010_add_invoice_accounting_fields`)

Cubre el envío automático de facturas al software contable del tenant. Por ahora soporta **Holded** y **Sage Despachos Connected** (REST). A3 (Wolters Kluwer) y NCS quedan diferidos a un sprint posterior. El plan completo está en `~/.local/share/kilo/plans/1784133600001-priority-two-fiscal-accounting.md`.

### New tables

- **`accounting_connections`** — una fila por tenant. Almacena los tokens OAuth cifrados en reposo (`encryptedAccessToken`, `encryptedRefreshToken`) con la `EncryptionService` del repo. Solo se guarda en claro `externalCompanyId`, `expiresAt`, `lastSyncAt`, `lastError`. Índice `(provider, isActive)`.
- **`accounting_sync_logs`** — log de auditoría por intento de sync (acción, status, `externalId`, `errorMessage`, payload). Indexado por `(tenantId, createdAt)` y por `invoiceId`.

### Invoice fields añadidos (migration `20260716140010`)

- `accountingStatus InvoiceAccountingStatus @default(not_synced)` — estado del intento de sync a Holded/Sage.
- `accountingExternalId String?` — id externo devuelto por el proveedor (se usa como clave de idempotencia).
- `accountingSyncedAt DateTime?` — cuándo se sincronizó por última vez con éxito.
- `accountingError String? @db.Text` — último error si falló el sync.

### Enum añadido

- `InvoiceAccountingStatus { not_synced | pending | synced | error }`.
- `AccountingProvider { holded | sage }`.

### Tenant field añadido

- `accountingSettings Json` — `{ provider, enabled, syncOnIssue }`. Default `{provider: null, enabled: false, syncOnIssue: true}`. `syncOnIssue=false` desactiva el sync automático al emitir (el owner sigue pudiendo disparar el sync manual desde `/dashboard/billing/invoices` o desde `/accounting/retry-queue`).

### Arquitectura

```
src/accounting/
  providers/
    provider.interface.ts   # AccountingProviderAdapter (OAuth + upsertSalesInvoice + ping)
    holded.adapter.ts       # REST — https://api.holded.com/api/invoicing/v1/...
    sage.adapter.ts         # REST — https://api.sageone.es/v1/...
  accounting.service.ts     # cola de retries + refresh automático de token + idempotencia
  accounting.controller.ts  # OAuth callback + sync + retry-queue + logs
  accounting.module.ts      # exporta AccountingService para InvoiceService
```

### Idempotencia

`AccountingService.syncInvoice(invoiceId)` usa `externalRef = ${tenantId.slice(0,8)}-${series}${number}` como `customId` para Holded y `document_number` para Sage. La firma de payload es determinista (HMAC-SHA256 con un secret-stub del adapter), así que un reintento sobre el mismo invoice devuelve el mismo `externalId`. Si `Invoice.accountingExternalId` ya está set, el sync se salta inmediatamente y se loguea como `skipped`.

### Refresh automático de token

`AccountingService.getValidTokens()` descifra `encryptedAccessToken` si `expiresAt > now+60s`. Si no, intenta refresh con el `encryptedRefreshToken`; si esto falla, marca `accountingStatus='error'` y deja el `lastError` en la conexión.

### Reintentos

`AccountingService.retryQueue(limit=50)` busca invoices con `accountingStatus='pending' AND accountingExternalId IS NULL` y los reprocesa. Diseñado para correr desde un cron cada 30 min como red de seguridad para errores 5xx transitorios.

### Out of scope (siguiente sprint)

- A3 (Wolters Kluwer) y NCS — sus APIs son SOAP con WS-Security, distinto del contrato actual.
- Webhooks de Holded/Sage para sync en tiempo real — el polling actual es cada 30 min.
- Mapping de IVA por línea Holded → `tax` vs Sage → `tax_rate` ya está hecho a nivel de adapter.