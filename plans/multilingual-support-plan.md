# Multilingual Support Implementation Plan

## Executive Summary

Implementing multilingual support (Spanish and English) for Kira Studio SaaS is **feasible and well-supported** by the existing architecture. The database already has a `language` field at the tenant level, and the virtual receptionist already supports both languages. The main work is in the frontend UI and notification system.

---

## Current State Analysis

### What's Already in Place ✅

| Component | Status | Details |
|-----------|--------|---------|
| Database | ✅ Ready | `Tenant.language` field defaults to "es" |
| Virtual Receptionist | ✅ Ready | Prompts exist in both ES and EN |
| User Model | ⚠️ Partial | Needs `language` field for user preference |
| Frontend UI | ❌ Not Ready | All text hardcoded in Spanish |
| Notifications | ❌ Not Ready | Messages hardcoded in Spanish |
| Email Templates | ❌ Not Ready | Templates in Spanish only |

### Architecture Diagram

```mermaid
flowchart TB
    subgraph Database
        A[Tenant] -->|"language field"| B((language: es|en))
    end
    
    subgraph "Backend"
        C[Auth Service] -->|reads| A
        D[Notification Service] -->|uses| B
        E[Virtual Receptionist] -->|already multilang| B
    end
    
    subgraph "Frontend"
        F[Admin Dashboard] -->|gets tenant lang| A
        G[Booking Widget] -->|gets tenant lang| A
        H[User Settings] -->|user preference| I((User.lang))
    end
    
    I -->|overrides| B
```

---

## Implementation Plan

### Phase 1: Database & Backend Changes

#### 1.1 Add User Language Preference
- **File**: `packages/backend/prisma/schema.prisma`
- **Action**: Add `language String @default("es")` to User model
- **No migration needed** - optional field with default

#### 1.2 Create Translation Service
- **New File**: `packages/backend/src/translations/translations.service.ts`
- **Purpose**: Central service for getting translated notification messages
- **Returns**: Translated strings based on tenant.language or user.language

#### 1.3 Create Translation Files
- **Location**: `packages/backend/src/translations/locales/`
- **Files**:
  - `es.json` - Spanish translations
  - `en.json` - English translations

#### 1.4 Update Notification Service
- **File**: `packages/backend/src/notifications/notifications.service.ts`
- **Action**: Use TranslationService to get messages in correct language
- **Affected**: All notify methods (appointment created, cancelled, reminder, etc.)

---

### Phase 2: Frontend i18n Setup

#### 2.1 Install i18n Library
- **Recommendation**: Use `next-intl` (v3.x for Next.js 14)
- **Package**: `npm install next-intl`
- **Config**: Create `i18n/request.ts` for route-based i18n

#### 2.2 Create Translation Files
- **Location**: `packages/frontend/app/[locale]/`
- **Structure**:
  ```
  app/
    [locale]/
      locale/
        es.json    # Spanish translations
        en.json    # English translations
  ```

#### 2.3 Create Translation Keys
Create a complete translation key hierarchy:

```json
// es.json (sample structure)
{
  "common": {
    "save": "Guardar",
    "cancel": "Cancelar",
    "delete": "Eliminar",
    "edit": "Editar",
    "loading": "Cargando..."
  },
  "nav": {
    "dashboard": "Panel",
    "appointments": "Citas",
    "clients": "Clientes",
    "services": "Servicios",
    "settings": "Configuración"
  },
  "dashboard": {
    "welcome": "Bienvenido",
    "stats": "Estadísticas"
  },
  "appointments": {
    "new": "Nueva Cita",
    "title": "Citas",
    "scheduled": "Programada",
    "confirmed": "Confirmada",
    "completed": "Completada",
    "cancelled": "Cancelada"
  }
}
```

#### 2.4 Create Language Context
- **New File**: `packages/frontend/lib/i18n.ts`
- **Purpose**: Hook to access translations with fallback
- **Features**:
  - Detect language from tenant settings
  - Allow user override
  - Support on-the-fly switching

#### 2.5 Wrap App with Provider
- **File**: `packages/frontend/app/layout.tsx`
- **Action**: Add NextIntlClientProvider

---

### Phase 3: Component Updates

#### 3.1 Create Translation Helper Hook
```typescript
// packages/frontend/lib/use-translation.ts
'use client'
import { useTranslations } from 'next-intl'

export function useT() {
  return useTranslations()
}
```

#### 3.2 Update All UI Components
This is the largest task - migrate all hardcoded strings:

| Component Type | Count | Effort |
|---------------|-------|--------|
| Navigation | ~50 strings | Low |
| Dashboard | ~100 strings | Medium |
| Forms | ~150 strings | Medium |
| Tables | ~80 strings | Low |
| Settings | ~200 strings | High |
| Widget/Booking | ~120 strings | High |

**Approach**:
1. Create mapping files for each page/section
2. Replace `<string>` with `<t('key')`
3. Handle dynamic content with interpolation

#### 3.3 Create Language Switcher Component
- **Location**: `components/languageswitcher.tsx`
- **UI**: Dropdown in header or settings
- **Options**: Español 🇪🇸 | English 🇬🇧

---

### Phase 4: Backend API & Caching

#### 4.1 Add Language to API Responses
- **Action**: Include tenant.language in auth response
- **File**: `packages/backend/src/auth/auth.service.ts`

#### 4.2 Store User Preference
- **Action**: Save user.language to database when changed
- **File**: Update user settings endpoint

#### 4.3 Cache Translations (Optional)
- **For production optimization**
- **Option**: Use Redis to cache loaded translations

---

### Phase 5: Testing & Deployment

#### 5.1 Test Scenarios
- [ ] Load app with es locale
- [ ] Load app with en locale
- [ ] Switch language in settings
- [ ] Verify tenant default applies
- [ ] Test booking widget in both languages
- [ ] Test notifications in both languages

#### 5.2 Fallback Strategy
- Missing translation → Fall back to Spanish (default)
- No user preference → Use tenant language
- No tenant language → Use Spanish

---

## Key Decisions Made

### Why This Approach?

1. **Tenant-level default**: Already in database, minimal changes
2. **User override**: Natural UX, easy to implement
3. **next-intl**: Best integration with Next.js 14 App Router
4. **JSON files**: Easy for translators, no extra tooling

### Alternative Considered

| Option | Rejected Because |
|--------|-----------------|
| External i18n service | Overkill for 2 languages |
| Database translations | Harder to manage, slower |
| Google Translate API | Not accurate enough for business terms |

---

## Estimated Scope

| Phase | Files to Modify | New Files | Complexity |
|-------|---------------|----------|------------|
| Database | 1 | 0 | Low |
| Backend | 4 | 5 | Medium |
| Frontend Core | 3 | 3 | Medium |
| UI Components | ~30 | 0 | High |
| **Total** | ~38 | 8 | **Medium-High** |

---

## Next Steps to Start Implementation

1. **Backend**: Add language field to User model
2. **Backend**: Create TranslationService and locale files
3. **Frontend**: Install next-intl, configure
4. **Frontend**: Create es.json / en.json with main keys
5. **Frontend**: Update a sample component (e.g., sidebar)
6. **Testing**: Verify language switching works

---

## Note on Virtual Receptionist

The Virtual Receptionist already supports both languages via prompts/templates.ts. It uses the tenant's language setting to determine which prompt version to use. No changes needed there.

---

*Plan created: 2026-04-03*
*For: Kira Studio SaaS*