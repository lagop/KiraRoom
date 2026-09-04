# Phase 3.2: Admin Dashboard - Architecture Documentation

**Created:** 2026-01-06
**Updated:** 2026-01-06
**Status:** Draft

---

## System Architecture Overview

### High-Level Architecture

```mermaid
graph TD
    subgraph Frontend[Next.js Frontend]
        A1[Dashboard Layout] --> A2[Pages]
        A1 --> A3[Components]
        A1 --> A4[State Management]
        A2 --> A2a[Clients]
        A2 --> A2b[Professionals]
        A2 --> A2c[Services]
        A2 --> A2d[Appointments]
        A2 --> A2e[Analytics]
    end
    
    subgraph Backend[NestJS Backend]
        B1[Admin Controllers] --> B2[Services]
        B1 --> B3[Guards]
        B2 --> B4[Prisma Client]
        B4 --> B5[PostgreSQL]
    end
    
    subgraph Auth[Authentication]
        C1[JWT Service] --> C2[Passport Strategy]
        C2 --> C3[Role Guards]
    end
    
    Frontend -->|HTTP API| Backend
    Frontend -->|JWT Tokens| Auth
    Backend -->|Auth Validation| Auth
    Auth -->|User Context| Backend
```

---

## Component Architecture

### Frontend Component Hierarchy

```mermaid
graph TD
    App --> DashboardLayout
    DashboardLayout --> DashboardHeader
    DashboardLayout --> DashboardSidebar
    DashboardLayout --> MainContent
    
    MainContent --> ClientsPage
    MainContent --> ProfessionalsPage
    MainContent --> ServicesPage
    MainContent --> AppointmentsPage
    MainContent --> AnalyticsPage
    
    ClientsPage --> ClientList
    ClientsPage --> ClientForm
    ClientList --> DataTable
    ClientList --> SearchFilter
    ClientList --> Pagination
    
    AppointmentsPage --> AppointmentCalendar
    AppointmentsPage --> AppointmentForm
    AppointmentCalendar --> FullCalendar
    AppointmentCalendar --> EventModal
    
    AnalyticsPage --> SummaryCards
    AnalyticsPage --> RevenueChart
    AnalyticsPage --> AppointmentChart
    AnalyticsPage --> ServiceChart
```

---

## Data Flow Architecture

### Clients Management Data Flow

```mermaid
sequenceDiagram
    participant User
    participant Frontend
    participant Backend
    participant Database
    
    User->>Frontend: Navigate to Clients Page
    Frontend->>Backend: GET /api/v1/admin/clients
    Backend->>Database: prisma.client.findMany()
    Database-->>Backend: Clients data
    Backend-->>Frontend: JSON response
    Frontend->>User: Display client list
    
    User->>Frontend: Click "Create Client"
    Frontend->>User: Show client form
    User->>Frontend: Submit form data
    Frontend->>Backend: POST /api/v1/admin/clients
    Backend->>Database: prisma.client.create()
    Database-->>Backend: Created client
    Backend-->>Frontend: Success response
    Frontend->>User: Show success message
```

---

## API Architecture

### RESTful API Design

```mermaid
classDiagram
    class AdminAPI {
        +GET    /clients
        +POST   /clients
        +GET    /clients/:id
        +PUT    /clients/:id
        +DELETE /clients/:id
        +GET    /clients/search
        
        +GET    /professionals
        +POST   /professionals
        +GET    /professionals/:id
        +PUT    /professionals/:id
        +DELETE /professionals/:id
        
        +GET    /services
        +POST   /services
        +GET    /services/:id
        +PUT    /services/:id
        +DELETE /services/:id
        
        +GET    /appointments
        +POST   /appointments
        +GET    /appointments/:id
        +PUT    /appointments/:id
        +DELETE /appointments/:id
        +GET    /appointments/calendar
        
        +GET    /analytics/summary
        +GET    /analytics/revenue
        +GET    /analytics/appointments
        +GET    /analytics/clients
        +GET    /analytics/services
    }
    
    class ResponseFormat {
        +status: number
        +data: object
        +message: string
        +timestamp: string
    }
    
    class ErrorResponse {
        +statusCode: number
        +message: string
        +error: string
        +details: object
    }
    
    AdminAPI --> ResponseFormat
    AdminAPI --> ErrorResponse
```

---

## Database Architecture

### Entity Relationship Diagram (Simplified)

```mermaid
erDiagram
    Tenant ||--o{ User : "has"
    Tenant ||--o{ Client : "has"
    Tenant ||--o{ Professional : "has"
    Tenant ||--o{ Service : "has"
    Tenant ||--o{ Appointment : "has"
    
    Client ||--o{ Appointment : "has"
    Professional ||--o{ Appointment : "has"
    Service ||--o{ Appointment : "has"
    
    User {
        string id
        string email
        string passwordHash
        string role
        string tenantId
    }
    
    Client {
        string id
        string firstName
        string lastName
        string email
        string phone
        string tenantId
    }
    
    Professional {
        string id
        string firstName
        string lastName
        string email
        string phone
        json workingHours
        string tenantId
    }
    
    Service {
        string id
        string name
        string description
        int duration
        decimal price
        string category
        string tenantId
    }
    
    Appointment {
        string id
        string clientId
        string professionalId
        string serviceId
        datetime scheduledDate
        string status
        decimal price
        string tenantId
    }
```

---

## Authentication Architecture

### JWT Authentication Flow

```mermaid
sequenceDiagram
    participant User
    participant Frontend
    participant Backend
    participant AuthService
    
    User->>Frontend: Enter credentials
    Frontend->>Backend: POST /auth/login {email, password}
    Backend->>AuthService: validateCredentials(email, password)
    AuthService->>Database: Find user by email
    Database-->>AuthService: User record
    AuthService->>AuthService: Compare password hash
    AuthService-->>Backend: User validated
    Backend->>AuthService: generateTokens(user)
    AuthService-->>Backend: {accessToken, refreshToken}
    Backend-->>Frontend: {tokens, user}
    Frontend->>User: Store tokens, redirect to dashboard
    
    User->>Frontend: Request protected resource
    Frontend->>Backend: GET /admin/clients (Authorization: Bearer token)
    Backend->>AuthService: verifyToken(token)
    AuthService-->>Backend: Decoded payload
    Backend->>AuthService: checkRoles(payload.roles)
    AuthService-->>Backend: Authorization granted
    Backend-->>Frontend: Protected data
```

---

## Frontend State Management Architecture

### State Management Strategy

```mermaid
graph TD
    subgraph GlobalState[Global State]
        A1[Auth State] -->|user, tokens| A2
        A2[UI State] -->|theme, layout| A3
        A3[Cache State] -->|data caching| A4
    end
    
    subgraph LocalState[Local State]
        B1[Form State] -->|form data| B2
        B2[Component State] -->|UI state| B3
    end
    
    subgraph ServerState[Server State]
        C1[SWR Cache] -->|API data| C2
        C2[React Query] -->|queries| C3
    end
    
    GlobalState -->|Context API| Components
    LocalState -->|useState| Components
    ServerState -->|hooks| Components
    Components -->|actions| GlobalState
    Components -->|mutations| ServerState
```

---

## Error Handling Architecture

### Error Handling Flow

```mermaid
graph TD
    A[API Request] --> B{Success?}
    B -->|Yes| C[Return Data]
    B -->|No| D{Error Type}
    
    D -->|401 Unauthorized| E[Redirect to Login]
    D -->|403 Forbidden| F[Show Access Denied]
    D -->|404 Not Found| G[Show Not Found]
    D -->|422 Validation| H[Show Form Errors]
    D -->|500 Server Error| I[Show Error Page]
    D -->|Network Error| J[Show Offline Message]
    
    E --> K[Clear Auth State]
    F --> L[Log Error]
    G --> L
    H --> M[Display Form Errors]
    I --> L
    J --> N[Retry Mechanism]
```

---

## Performance Architecture

### Performance Optimization Strategy

```mermaid
graph TD
    A[Frontend Performance] --> B[Code Splitting]
    A --> C[Lazy Loading]
    A --> D[Bundle Optimization]
    A --> E[Image Optimization]
    
    F[Backend Performance] --> G[Database Indexing]
    F --> H[Query Optimization]
    F --> I[Caching Strategy]
    F --> J[Connection Pooling]
    
    K[API Performance] --> L[Pagination]
    K --> M[Response Compression]
    K --> N[Rate Limiting]
    K --> O[ETag Caching]
    
    P[Monitoring] --> Q[Performance Metrics]
    P --> R[Error Tracking]
    P --> S[Logging]
```

---

## Security Architecture

### Security Layers

```mermaid
graph TD
    A[Network Layer] --> B[HTTPS/TLS]
    A --> C[CORS Configuration]
    A --> D[Rate Limiting]
    
    E[Application Layer] --> F[Input Validation]
    E --> G[Authentication]
    E --> H[Authorization]
    E --> I[CSRF Protection]
    
    J[Data Layer] --> K[Password Hashing]
    J --> L[SQL Injection Prevention]
    J --> M[Data Encryption]
    J --> N[Secure Headers]
    
    O[Monitoring Layer] --> P[Security Logging]
    O --> Q[Anomaly Detection]
    O --> R[Audit Trails]
```

---

## Deployment Architecture

### Production Deployment

```mermaid
graph TD
    subgraph Production[Production Environment]
        A1[Nginx] --> A2[Next.js Frontend]
        A1 --> A3[NestJS Backend]
        A3 --> A4[PostgreSQL]
        A3 --> A5[Redis]
    end
    
    subgraph CI[CI/CD Pipeline]
        B1[GitHub Actions] --> B2[Testing]
        B2 --> B3[Build]
        B3 --> B4[Docker Build]
        B4 --> B5[Deploy]
    end
    
    subgraph Monitoring[Monitoring]
        C1[Prometheus] --> C2[Grafana]
        C3[Sentry] --> C4[Error Tracking]
        C5[Logging] --> C6[ELK Stack]
    end
    
    CI -->|Deploys to| Production
    Production -->|Metrics to| Monitoring
    Monitoring -->|Alerts to| DevTeam
```

---

## Technical Decisions

### Key Architectural Decisions

1. **Monorepo Structure**
   - Decision: Use Nx monorepo for shared code
   - Rationale: Better code sharing, unified tooling
   - Impact: Simplified dependency management

2. **Authentication Strategy**
   - Decision: JWT with refresh tokens
   - Rationale: Stateless, scalable, industry standard
   - Impact: Requires proper token management

3. **State Management**
   - Decision: Context API + SWR
   - Rationale: Simpler than Redux, built-in caching
   - Impact: May need Redux for complex state

4. **UI Framework**
   - Decision: shadcn/ui with Tailwind
   - Rationale: Customizable, accessible, modern
   - Impact: Learning curve for Tailwind

5. **Calendar Library**
   - Decision: FullCalendar
   - Rationale: Feature-rich, well-documented
   - Impact: Bundle size consideration

---

## Future Considerations

### Scalability Path

```mermaid
graph TD
    A[Current: Monolithic] --> B[Phase 1: Service-Oriented]
    B --> C[Phase 2: Microservices]
    C --> D[Phase 3: Serverless]
    
    A -->|Backend| A1[NestJS Monolith]
    B -->|Backend| B1[Modular NestJS]
    C -->|Backend| C1[Separate Services]
    D -->|Backend| D1[Lambda Functions]
    
    A -->|Frontend| A2[Next.js SSR]
    B -->|Frontend| B2[Next.js ISR]
    C -->|Frontend| C2[Micro-frontends]
    D -->|Frontend| D1[Edge Functions]
```

---

## Appendix

### Glossary

- **CRUD**: Create, Read, Update, Delete operations
- **JWT**: JSON Web Token for authentication
- **Prisma**: ORM for database access
- **SWR**: React hooks for data fetching
- **DTO**: Data Transfer Object
- **RBAC**: Role-Based Access Control

### References

- Main Plan: [`CONSOLIDATED-PLAN.md`](CONSOLIDATED-PLAN.md)
- Database Schema: [`docs/database-schema.md`](../docs/database-schema.md)
- API Design: [`docs/api-design.md`](../docs/api-design.md)

---

## Change Log

- **2026-01-06:** Initial architecture documentation created
- **2026-01-06:** Added detailed diagrams and flow charts
- **2026-01-06:** Included security and performance considerations