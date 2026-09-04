# BeautyPro SaaS - Plataforma para Salones de Belleza

## Descripción del Proyecto

BeautyPro es una plataforma SaaS completa diseñada específicamente para salones de belleza, spas y peluquerías. Ofrece herramientas de gestión integral que incluyen programación de citas, gestión de clientes, control de inventario, reportes de negocio y más.

### Características Principales

- **Gestión de Citas**: Sistema completo de programación con calendario inteligente
- **Gestión de Clientes**: Base de datos detallada con historial de servicios
- **Control de Inventario**: Seguimiento de productos y materiales
- **Gestión de Empleados**: Control de horarios y comisiones
- **Facturación**: Generación automática de facturas
- **Reportes**: Análisis de rendimiento del negocio
- **Notificaciones**: Recordatorios automáticos a clientes
- **Kira Copilot** (panel interno): asistente IA con briefing diario + 8 herramientas de lectura + 6 acciones con aprobación humana (mover citas, enviar WhatsApp, crear cupones…). Plan Pro = lectura; Premium = escritura. Ver [`docs/staff-copilot-guide.md`](docs/staff-copilot-guide.md).
- **Multi-idioma**: Español e inglés
- **Multi-moneda**: Soporte para diferentes monedas

### Público Objetivo

- Salones de belleza y spas
- Peluquerías y barberías
- Centros de estética
- Propietarios de salones
- Gerentes de negocio

## Plan de Desarrollo

### Fase 1: Configuración Inicial
- [x] Definir arquitectura del proyecto
- [x] Configurar estructura de carpetas
- [ ] Configurar variables de entorno
- [ ] Configurar base de datos
- [ ] Configurar sistema de autenticación

### Fase 2: Módulos Core
- [ ] Módulo de autenticación
- [ ] Dashboard principal
- [ ] Gestión de citas
- [ ] Gestión de clientes

### Fase 3: Módulos Avanzados
- [ ] Gestión de inventario
- [ ] Facturación
- [ ] Reportes y analytics
- [ ] Notificaciones

### Fase 4: Características Avanzadas
- [ ] Aplicación móvil
- [ ] API para integraciones
- [ ] Multi-tenant
- [ ] Características premium

### Fase 5: Optimización y Lanzamiento
- [ ] Testing y QA
- [ ] Optimización de rendimiento
- [ ] Documentación
- [ ] Preparación para producción

## Stack Tecnológico

- **Backend**: Node.js + Express + TypeScript
- **Frontend**: React + TypeScript + Vite
- **Base de Datos**: PostgreSQL + Prisma ORM
- **Autenticación**: JWT + bcrypt
- **Estilos**: Tailwind CSS
- **Notificaciones**: Nodemailer + Socket.io
- **Pagos**: Stripe + PayPal
- **Despliegue**: Docker + PM2

## Estructura del Proyecto

```
beautypro-saas/
├── backend/              # Servidor backend (Node.js + Express)
├── frontend/             # Aplicación frontend (React + TypeScript)
├── docs/                 # Documentación
├── docker-compose.yml    # Configuración Docker
└── README.md            # Este archivo
```

## Instalación y Configuración

### Prerrequisitos
- Node.js 18+
- PostgreSQL 14+
- npm o yarn
- Git

### Pasos de Instalación

1. **Clonar el repositorio**
   ```bash
   git clone <repository-url>
   cd beautypro-saas
   ```

2. **Configurar variables de entorno**
   ```bash
   # Copiar archivos de ejemplo
   cp backend/.env.example backend/.env
   cp frontend/.env.example frontend/.env
   ```

3. **Instalar dependencias del backend**
   ```bash
   cd backend
   npm install
   ```

4. **Instalar dependencias del frontend**
   ```bash
   cd ../frontend
   npm install
   ```

5. **Configurar la base de datos**
   ```bash
   # Crear base de datos PostgreSQL
   createdb beautypro_db
   
   # Ejecutar migraciones
   cd ../backend
   npx prisma migrate dev
   ```

6. **Ejecutar en modo desarrollo**
   ```bash
   # Terminal 1 - Backend
   cd backend && npm run dev
   
   # Terminal 2 - Frontend
   cd frontend && npm run dev
   ```

## Uso

### Acceso a la Aplicación
- Frontend: http://localhost:3000
- Backend API: http://localhost:3001
- Documentación API: http://localhost:3001/api-docs

### Usuario de Prueba
Para facilitar las pruebas, se puede crear un usuario administrador mediante la API o mediante el archivo de seed de la base de datos.

## Desarrollo

### Convenciones de Código
- TypeScript para tipado fuerte
- ESLint + Prettier para linting y formato
- Convenciones de nombres en camelCase
- Documentación JSDoc para funciones complejas

### Testing
```bash
# Backend
cd backend && npm test

# Frontend
cd frontend && npm test
```

### Scripts Disponibles
- `npm run dev` - Ejecutar en desarrollo
- `npm run build` - Construir para producción
- `npm start` - Ejecutar en producción
- `npm test` - Ejecutar tests

## Deployment

### Docker
```bash
# Construir y ejecutar con Docker Compose
docker-compose up --build

# Solo construcción
docker-compose build
```

### Variables de Entorno en Producción
Asegúrate de configurar las siguientes variables en producción:
- `NODE_ENV=production`
- `DATABASE_URL` - URL de PostgreSQL
- `JWT_SECRET` - Secreto para JWT
- `SMTP_HOST` - Servidor de email
- `STRIPE_SECRET_KEY` - Clave secreta de Stripe

## API Endpoints

### Autenticación
- `POST /api/auth/register` - Registro de usuario
- `POST /api/auth/login` - Iniciar sesión
- `GET /api/auth/profile` - Perfil de usuario

### Citas
- `GET /api/appointments` - Listar citas
- `POST /api/appointments` - Crear cita
- `PUT /api/appointments/:id` - Actualizar cita
- `DELETE /api/appointments/:id` - Cancelar cita

### Clientes
- `GET /api/clients` - Listar clientes
- `POST /api/clients` - Crear cliente
- `PUT /api/clients/:id` - Actualizar cliente
- `DELETE /api/clients/:id` - Eliminar cliente

### Servicios
- `GET /api/services` - Listar servicios
- `POST /api/services` - Crear servicio
- `PUT /api/services/:id` - Actualizar servicio
- `DELETE /api/services/:id` - Eliminar servicio

### Empleados
- `GET /api/employees` - Listar empleados
- `POST /api/employees` - Crear empleado
- `PUT /api/employees/:id` - Actualizar empleado
- `DELETE /api/employees/:id` - Eliminar empleado

### Reportes
- `GET /api/reports/appointments` - Reporte de citas
- `GET /api/reports/revenue` - Reporte de ingresos
- `GET /api/reports/clients` - Reporte de clientes

### Kira Copilot (staff-side assistant)
Documentación completa: [`docs/staff-copilot-guide.md`](docs/staff-copilot-guide.md) ·
[`docs/admin-copilot-guide.md`](docs/admin-copilot-guide.md) ·
[`docs/saas-copilot-runbook.md`](docs/saas-copilot-runbook.md) ·
[`docs/staff-copilot-changelog.md`](docs/staff-copilot-changelog.md)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/assistant/conversations` | JWT (panel) | Create or resume a conversation |
| `GET` | `/api/v1/assistant/conversations` | JWT (panel) | List the user's conversations |
| `GET` | `/api/v1/assistant/conversations/:id/messages` | JWT (panel) | Message history for a conversation |
| `POST` | `/api/v1/assistant/messages` | JWT + Pro+ | Send a user message; the LLM replies with grounded salon data |
| `GET` | `/api/v1/assistant/insights/daily` | JWT + Pro+ | Daily briefing for the calling user |
| `GET` | `/api/v1/assistant/tier` | JWT | Effective copilot tier + tool sets for the tenant |
| `GET` | `/api/v1/assistant/usage` | JWT + Pro+ | Monthly usage stats for the tenant |
| `POST` | `/api/v1/assistant/approvals/:id/resolve` | JWT + Premium | Approve or reject a pending action |
| `POST` | `/api/v1/assistant/feedback` | JWT + Pro+ | Thumbs up/down + comment on an assistant reply |
| `GET` | `/api/v1/saas/admin/assistant/usage` | saas_owner | Per-tenant copilot usage (platform admin) |

## Contribución

1. Fork el proyecto
2. Crear una rama para tu feature (`git checkout -b feature/AmazingFeature`)
3. Commit tus cambios (`git commit -m 'Add some AmazingFeature'`)
4. Push a la rama (`git push origin feature/AmazingFeature`)
5. Abrir un Pull Request

## Licencia

Este proyecto está bajo la Licencia MIT. Ver el archivo `LICENSE` para más detalles.

## Soporte

Para soporte técnico o consultas:
- Email: soporte@beautypro.com
- Documentación: [docs.beautypro.com](https://docs.beautypro.com)
- Issues: [GitHub Issues](https://github.com/tu-usuario/beautypro-saas/issues)

## Roadmap

### Versión 1.0 (MVP)
- [x] Estructura base del proyecto
- [ ] Autenticación y autorización
- [ ] Gestión de citas
- [ ] Gestión de clientes
- [ ] Dashboard básico

### Versión 1.1
- [ ] Gestión de inventario
- [ ] Facturación básica
- [ ] Notificaciones por email

### Versión 1.2
- [ ] Reportes básicos
- [ ] Aplicación móvil
- [ ] API para integraciones

### Versión 2.0
- [ ] Multi-tenant
- [ ] Características premium
- [ ] Integración con sistemas de pago
- [ ] Analytics avanzados

---

**BeautyPro SaaS** - Revolucionando la gestión de salones de belleza 💅✨