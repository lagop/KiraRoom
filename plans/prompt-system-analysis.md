# Análisis: Sistema de Prompts Propuesto vs Implementación Actual

## 📊 Evaluación Comparativa

### Sistema Actual (Lo que tenemos)

| Componente | Estado | Descripción |
|------------|--------|-------------|
| **System Prompt** | ⚠️ Básico | Solo identidad básica, sin reglas claras de comportamiento |
| **Contexto Dinámico** | ✅ Parcial | Solo nombre, dirección, teléfono, servicios, profesionales |
| **FAQ en Prompts** | ❌ No implementado | FAQs se manejan por separado, no en prompts |
| **Políticas del Salón** | ❌ No implementado | Sin políticas de cancelación, depósitos, etc. |
| **Clasificación de Intención** | ✅ Básico | Regex/keywords, sin confianza (confidence) |
| **Flujo de Reserva** | ❌ No implementado | No hay guía paso a paso en prompts |
| **Escalación a Humano** | ❌ No implementado | No hay prompt de derivación |
| **Nombre Asistente** | ❌ No implementado | Solo "KiraRoom" genérico |
| **Multiidioma** | ⚠️ Parcial | OpenAI en inglés, otros en español |

### Sistema Propuesto (Nuevo)

| Componente | Mejora |
|------------|--------|
| **System Prompt** | ✅ Completo con identidad, personalidad, reglas de comportamiento |
| **Contexto Dinámico** | ✅ Completo con FAQs, políticas, horarios detallados |
| **FAQ en Prompts** | ✅ Se inyectan directamente en el contexto |
| **Políticas del Salón** | ✅ Políticas de cancelación, depósitos, etc. |
| **Clasificación de Intención** | ✅ Con confianza (0.0-1.0) y extracción de entidades |
| **Flujo de Reserva** | ✅ Guía por etapas (INITIAL → COMPLETED) |
| **Escalación a Humano** | ✅ Prompt dedicado para quejas/feedback |
| **Nombre Asistente** | ✅ Personalizable ({{ASSISTANT_NAME}}) |
| **Multiidioma** | ✅ Instrucciones para responder en idioma del cliente |

---

## 🎯 Veredicto

**El sistema propuesto es MEJOR y más COMPLETO** que el actual. Aporta mejoras significativas en:

1. **Profesionalismo**: Rules claras de comportamiento
2. **Precisión**: Contextos más ricos reducen alucinaciones
3. **Eficiencia**: Flujo de reserva guiado reduce errores
4. **Experiencia de usuario**: Nombre del asistente, emojis, formato consistente
5. **Mantenibilidad**: Arquitectura modular (5 prompts separados)

---

## 📋 Plan de Integración

### Fase 1: Preparación (Datos)

1. **Verificar campos en Tenant**:
   - ✅ name, slug, email, phone, whatsapp, street, city, state, country, timezone, language
   - ❌ Faltan: cancellationPolicy, minCancelHours, depositRequired - **AGREGAR al schema**

2. **Verificar FAQs**: Ya existen en FAQService - **REUTILIZAR**

### Fase 2: Crear Prompt Templates

Crear archivo: `packages/backend/src/virtual-receptionist/prompts/templates.ts`

```typescript
export const SYSTEM_PROMPT = `...`;
export const DYNAMIC_CONTEXT = `...`;
export const INTENT_CLASSIFIER = `...`;
export const BOOKING_FLOW = `...`;
export const ESCALATION = `...`;
```

### Fase 3: Actualizar Analysis Service

- Agregar `confidence: number` al resultado
- Agregar extracción de entidades (service, professional, date, time, etc.)
- Opcional: Usar LLM para clasificación (temperatura 0.0)

### Fase 4: Actualizar Providers

- Unificar estructura de prompts
- Usar los nuevos templates
- Mantener compatibilidad con múltiples LLM

### Fase 5: Actualizar LLM Service

- Ensamblar prompts según la lógica del pseudocódigo
- Manejar estado de reserva en sesión
- Implementar lógica de escalación

---

## 🔄 Diferencias de Variables

### Variables disponibles en DB actual:

| Variable Propuesta | Campo DB | Notas |
|-------------------|----------|-------|
| `{{SALON_NAME}}` | `tenant.name` | ✅ |
| `{{SALON_ADDRESS}}` | `tenant.street + city + state` | ✅ |
| `{{SALON_PHONE}}` | `tenant.phone` | ✅ |
| `{{SALON_WHATSAPP}}` | `tenant.whatsapp` | ✅ |
| `{{SALON_EMAIL}}` | `tenant.email` | ✅ |
| `{{SALON_TIMEZONE}}` | `tenant.timezone` | ✅ |
| `{{SALON_HOURS}}` | ❌ | **No existe** - need field or logic |
| `{{CANCELLATION_POLICY}}` | ❌ | **No existe** - need agregar |
| `{{MIN_CANCEL_HOURS}}` | ❌ | **No existe** - need agregar |
| `{{ASSISTANT_NAME}}` | ❌ | **No existe** - need agregar o hardcode |

### Servicios y Profesionales:

| Variable Propuesta | Campo DB | Notas |
|-------------------|----------|-------|
| `{{SERVICES}}` | `tenant.services[]` | ✅ Con name, duration, price, category |
| `{{PROFESSIONALS}}` | `tenant.professionals[]` | ✅ Con firstName, lastName, position, specialties |
| `{{FAQS}}` | `FAQService.getFAQs()` | ✅ Ya existen |

---

## ⚠️ Recomendaciones

1. **Agregar campos al schema.prisma**:
   - `cancellationPolicy: String?`
   - `minCancelHours: Int?` 
   - `assistantName: String?` (default "Kira")
   - `openingHours: Json?` (horarios por día)

2. **No eliminar el sistema actual** de golpe - implementar gradualmente

3. **Mantener backwards compatibility** con el sistema actual durante transición

4. **Considerar caching** del contexto dinámico (Prompt 2) por sesión

5. **Parámetros LLM**: Implementar los recomendados por prompt type

---

## 📝 siguiente paso

¿Te parece bien este análisis? ¿Comenzamos con la implementación?

**Opciones:**
1. ✅ Implementar el sistema completo de prompts
2. 🔶 Implementar solo partes específicas (System Prompt + Contexto)
3. 🔶 Primero agregar campos faltantes al schema
4. 🔶 Revisar más detalles antes de proceder
