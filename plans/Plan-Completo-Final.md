# ⚠️ DEPRECATED: Plan Completo Final para Salones de Belleza

> **Este documento está obsoleto.**
> **Plan Actual:** [`CONSOLIDATED-PLAN.md`](CONSOLIDATED-PLAN.md) es la fuente única de verdad.
> 
> Este archivo se conserva solo como referencia histórica.

---

## 1. Contexto de Trabajo y Estrategia General

**Rol**: Desarrollador único + herramientas de IA
**Dedicación**: 5h/día, 6 días/semana ≈ 30h/semana
**Estrategia**: Lanzar MVP enfocado en 2 meses, monetizar pronto con Plan Básico y validar con clientes reales en cada etapa

### Fases de Desarrollo
- **Fase 1 (Meses 1–2)**: MVP reservas + agenda → base del Plan Básico
- **Fase 2 (Meses 3–4)**: Plan Básico completo + base Profesional  
- **Fase 3 (Meses 5–8)**: Plan Profesional completo (automatización + marketing + fidelización)
- **Fase 4 (Meses 9–15)**: Plan Avanzado (multi-sucursal, personal, inventario, TPV, IA avanzada)

## 2. Arquitectura Técnica

### Stack Tecnológico
- **Monorepo**: Nx workspace con packages/ para shared, backend, frontend
- **Frontend**: Next.js 14+ con React 18, TypeScript, Tailwind CSS
- **Backend**: Nest.js (Node.js) con TypeScript, decorators, dependency injection
- **Base de Datos**: PostgreSQL (principal) + Redis (caché/sesiones)
- **Autenticación**: NextAuth.js con JWT
- **Pagos**: Stripe (MVP), expansible a procesadores regionales
- **Cloud**: AWS/GCP/Azure (multi-cloud ready)
- **Storage**: AWS S3/CloudFlare R2
- **Tiempo Real**: Socket.io/Pusher
- **Monitoreo**: Sentry + CloudWatch/Prometheus
- **IA/ML**: OpenAI API para automatizaciones inteligentes

### Arquitectura Multi-Tenant
```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Frontend      │    │   Backend API   │    │   PostgreSQL    │
│   (Next.js)     │◄──►│   (Node.js)     │◄──►│   Multi-tenant  │
│                 │    │                 │    │                 │
│ • Admin Panel   │    │ • REST API      │    │ • Row-level     │
│ • Booking UI    │    │ • GraphQL       │    │   Security      │
│ • Staff Portal  │    │ • WebSockets    │    │ • Tenant ID     │
│ • Client Area   │    │ • Auth Middleware│   │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         │              ┌─────────────────┐              │
         │              │   Cache Layer   │              │
         └──────────────┤   (Redis)       ├──────────────┘
                        │                 │
                        │ • Session Store │
                        │ • Rate Limiting │
                        │ • Queue System  │
                        └─────────────────┘
```

## 3. Planes Comerciales y Servicios

### Plan Básico – "Reservas 24/7"
**Enfocado a salones pequeños que quieren digitalizar reservas y agenda**

#### Funcionalidades Core
- ✅ Agenda online multiempleado (día/semana, bloqueos, vacaciones)
- ✅ Reservas online 24/7 (web/QR/Instagram) con selección de servicio, profesional y horario
- ✅ Gestión de servicios (nombre, duración, precio)
- ✅ Ficha básica de cliente (contacto, histórico de citas)
- ✅ Confirmaciones y recordatorios automáticos por email (y SMS opcional)
- ✅ Cancelación/reprogramación con reglas de política de cancelación
- ✅ Panel básico de estadísticas (citas, cancelaciones, ocupación)

#### Automatización/IA Incluida
- 🧠 Recordatorios inteligentes según tipo de servicio y riesgo de no-show
- 🧠 Sugerencia de huecos óptimos para rellenar la agenda sin "huecos tontos"

### Plan Profesional – "Automatización & Marketing"
**Dirigido a salones con más volumen que quieren aumentar recurrencia y ticket medio**

#### Incluye Plan Básico +:
- ✅ CRM avanzado: etiquetas, notas, preferencias, ticket medio, frecuencia
- ✅ Segmentación de clientes (nuevos, frecuentes, inactivos, alto valor, no-show)
- ✅ Campañas automatizadas (email/SMS/WhatsApp) de reactivación, recordatorios de servicio, bienvenida y cumpleaños
- ✅ Programa de fidelización (puntos, bonos, recompensas configurables)
- ✅ Encuestas post-servicio y empuje hacia reseñas (Google/Facebook)
- ✅ Informes de marketing (reservas/ingresos atribuidos a campañas y flujos)

#### Automatización/IA Adicional
- 🧠 Motor de "campañas sugeridas" según segmentos fríos o de alto potencial
- 🧠 Recomendación de servicios complementarios (upsell/cross-sell) en comunicaciones
- 🧠 Chatbot básico web/WhatsApp integrado con agenda para FAQs y reservas

### Plan Avanzado – "Gestión Integral + IA"
**Pensado para salones medianos/grandes y cadenas que quieren control integral**

#### Incluye Plan Profesional +:
- ✅ Multi-sucursal (varias sedes, permisos, reporting consolidado)
- ✅ Gestión de personal (turnos, vacaciones, límites de citas, comisiones, KPIs)
- ✅ Inventario (stocks, consumos por servicio, avisos de reposición)
- ✅ TPV/caja (cobro presencial, descuentos, vales, cierres diarios)
- ✅ Reporting financiero (facturación por servicio/profesional/sucursal, márgenes aproximados)
- ✅ API e integraciones externas (contabilidad, webs, marketing)

#### Automatización/IA Avanzada
- 🧠 Predicción de demanda por franja, servicio y profesional
- 🧠 Sugerencias de promociones dinámicas para horas valle/servicios infrautilizados
- 🧠 Lista de espera inteligente y relleno automático de huecos tras cancelaciones
- 🧠 Dashboards avanzados (LTV, cohortes, forecast de ingresos)

## 4. Cronograma Completo con Fases, Hitos y Entregables

### Fase 1 (Meses 1–2) – MVP reservas + agenda (base Plan Básico)
**Objetivo**: Sistema funcional de reservas y agenda listo para 1–3 salones piloto

#### Hitos

**H1 – Arquitectura y UX base**
- Definir entidades principales (salón, usuario, servicio, profesional, cliente, cita) y sus relaciones
- Diseñar flujos clave (reservar cita, gestionar agenda, configurar horario)

**H2 – Backend núcleo**
- Autenticación (propietario/salón, staff básico)
- Endpoints para servicios, profesionales, clientes y citas

**H3 – Widget/página de reservas**
- Selección de servicio, profesional opcional, fecha y hora disponibles
- Validación básica de slots y creación de cita

**H4 – Agenda interna**
- Vista día/semana por profesional
- Alta/edición/cancelación de citas, bloqueos de tiempo y vacaciones

**H5 – Notificaciones básicas y panel mínimo**
- Emails de confirmación y recordatorios simples
- Panel con nº de citas por día, cancelaciones y ocupación básica

#### Entregables de Fase 1
- 📋 Doc de arquitectura + esquema de base de datos
- 🚀 Backend desplegado en VPS (API lista)
- 💻 UI básica de reservas y agenda responsive
- ⚙️ Configuración de horarios, servicios y profesionales por salón
- 📊 Primer panel de métricas básicas

### Fase 2 (Meses 3–4) – Plan Básico completo + base Profesional
**Objetivo**: Cerrar un Plan Básico vendible y preparar los primeros bloques de marketing/CRM

#### Hitos

**H6 – Área cliente**
- Vista de próximas citas e historial
- Cancelación/reprogramación respetando políticas configuradas

**H7 – Pagos online**
- Integración con Stripe/TPV para depósito o pago completo
- Reglas de depósito y penalizaciones por cancelación tardía

**H8 – SMS como canal adicional**
- Integración con proveedor (Twilio u otro) para recordatorios y confirmaciones

**H9 – CRM mejorado**
- Notas por cliente, etiquetas simples (VIP, no-show, etc.)

**H10 – Segmentación básica y campañas manuales**
- Filtros: activos/inactivos por días, nº de visitas, importe gastado
- Envío manual de campañas (email/SMS) a un segmento seleccionado

#### Entregables de Fase 2
- 👤 Área cliente funcional (login o enlaces seguros)
- 💳 Flujo de pagos online integrado en la reserva y en el panel interno
- 📱 SMS operativo en los momentos clave (confirmación/recordatorio)
- 📝 Vista de CRM con ficha de cliente ampliada
- 📧 Módulo de campañas manuales con selección de segmento y plantilla

### Fase 3 (Meses 5–8) – Plan Profesional completo (automatización & marketing)
**Objetivo**: Construir un motor de automatización de marketing y fidelización claramente diferenciador

#### Hitos

**H11 – Automatizaciones de marketing por eventos**
- Flujos predefinidos: bienvenida, reactivación, recordatorio de servicio, cumpleaños
- Editor simple para activar/desactivar y ajustar parámetros

**H12 – Programa de fidelización**
- Reglas de puntos (por € gastado o visita)
- Canje de puntos por servicios/descuentos y notificaciones al cliente

**H13 – Encuestas y reseñas**
- Envío automático de encuesta tras la cita
- Redirección al cliente a Google/Facebook si la valoración es alta

**H14 – Reporting de marketing**
- Métricas por campaña/automatización (envíos, aperturas, reservas, ingresos)

**H15 – Chatbot básico**
- Bot web/WhatsApp que responda FAQs y cree reservas con lógica simple

#### Entregables de Fase 3
- 🤖 UI de automatizaciones (lista de flujos, estados, parámetros)
- 🎁 Configuración y visualización del programa de puntos en la ficha de cliente
- 📋 Plantillas de encuestas y flujo hacia reseñas
- 📈 Panel de resultados de marketing, enlazado con reservas reales
- 💬 Chatbot funcional conectado a la agenda con autenticación básica

### Fase 4 (Meses 9–15) – Plan Avanzado + IA avanzada
**Objetivo**: Ofrecer gestión integral de negocio y capacidades de IA avanzada para salones grandes y cadenas

#### Hitos

**H16 – Multi-sucursal y permisos**
- Múltiples sedes por cuenta, usuarios asociados a centros, roles y vistas por centro

**H17 – Módulo de personal**
- Turnos, vacaciones, límites de citas, cálculo de comisiones y KPIs

**H18 – Inventario**
- Fichas de productos, movimientos de stock, consumo por servicio, alertas de mínimos

**H19 – TPV/caja**
- Cobro presencial, descuentos, vales, cierres de caja diarios

**H20 – API & integraciones**
- Endpoints principales para contabilidad, webs y herramientas de marketing

**H21 – IA avanzada**
- Predicción de demanda por franja/servicio/profesional
- Sugerencias de promos dinámicas (horas valle, servicios infrautilizados)
- Lista de espera inteligente y re-asignación automática de huecos
- Dashboards de negocio (LTV, cohortes, forecast de ingresos)

#### Entregables de Fase 4
- 🏢 Panel multi-sucursal con filtros por centro y rol
- 👥 Módulo de personal integrado con agenda y reporting
- 📦 Inventario funcional enlazado con servicios y consumo
- 💰 TPV/caja operativo con informes diarios
- 🔌 API documentada para partners
- 📊 Panel de IA avanzada con predicciones, sugerencias y visualizaciones clave

## 5. Estrategia de Mercado

### Mercados Objetivo
- **Mercado Hispano**: España, México, Argentina, Colombia
- **Mercado Anglo**: Estados Unidos, Reino Unido, Canadá

### Adaptación Cultural
- **Hispano**: Integración WhatsApp, métodos de pago locales
- **Anglo**: Email/SMS estándar, Stripe/PayPal
- **Idiomas**: Español/Inglés con soporte completo
- **Monedas**: EUR, USD, MXN, ARS, COP con conversión automática

### Diferenciadores Competitivos
1. **IA predictiva** para optimizar agenda y marketing
2. **Automatización inteligente** sin configuración compleja
3. **Enfoque específico** en necesidades de salones de belleza
4. **Multi-tenant escalable** desde salones individuales hasta cadenas

## 6. Modelo de Precios Propuesto

### Plan Básico - €29/mes
- Hasta 2 profesionales
- 500 citas/mes
- Email + SMS notifications
- Soporte básico

### Plan Profesional - €79/mes
- Hasta 10 profesionales
- Citas ilimitadas
- Automatizaciones + CRM
- WhatsApp + chatbot
- Soporte prioritario

### Plan Avanzado - €199/mes
- Profesionales ilimitados
- Multi-sucursal
- TPV + inventario
- IA avanzada + API
- Soporte dedicado

## 7. Hitos de Monetización

### Mes 2-3: Lanzamiento Plan Básico
- Target: 10-20 salones piloto
- Precio: €19/mes (early bird)
- Objetivo: Validar product-market fit

### Mes 4-6: Escalado Plan Básico + Profesional
- Target: 50-100 salones
- Precio: €29/mes (Plan Básico), €79/mes (Profesional)
- Objetivo: $5,000 MRR

### Mes 7-12: Plan Avanzado + Expansión
- Target: 200-500 salones
- Objetivo: $25,000 MRR
- Expansión internacional

## 8. Recursos y Costos

### Equipo (Crecimiento progresivo)
- **Meses 1-6**: Solo desarrollador
- **Meses 7-12**: + 1 desarrollador frontend
- **Meses 13-18**: + 1 desarrollador backend + 1 UX/UI
- **Meses 19-24**: + 1 DevOps + 1 Marketing

### Infraestructura (Mensual)
- **Desarrollo**: $200-500
- **Producción inicial**: $1,000-2,000
- **Producción escalando**: $5,000-10,000

### ROI Proyectado
- **Año 1**: Inversión €50,000 → Revenue €150,000
- **Año 2**: Investment €200,000 → Revenue €800,000
- **Año 3**: Break-even + expansión internacional

## 9. Siguiente Paso

**Acción inmediata**: Comenzar Fase 1 con arquitectura y UX base
**Timeline**: Inicio desarrollo H1 en los próximos 7 días
**Milestone**: MVP funcional en 60 días listo para pilotos

Este plan proporciona una hoja de ruta clara y realista para construir un SaaS competitivo en el mercado de salones de belleza, con un enfoque en la validación temprana y el crecimiento escalonado.