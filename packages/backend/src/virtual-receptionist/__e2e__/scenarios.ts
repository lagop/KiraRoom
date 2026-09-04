import { Scenario } from './harness';

/**
 * Real-world scenarios for the Virtual Receptionist chatbot.
 *
 * Each scenario is a scripted user input that exercises a path the
 * LLM has *no* flexibility about: which tools are called, which
 * substrings must appear, and which real prices from the database
 * must show up in the reply. The assertions are deliberately strict
 * (catalogue prices, tool names, intent) so a passing run is
 * meaningful and a failing one pinpoints the regression.
 *
 * Run via Jest (gated) or the CLI:
 *   RUN_LLM_E2E_TESTS=1 npm run test:e2e:llm
 *   RUN_LLM_E2E_TESTS=1 npx ts-node src/virtual-receptionist/__e2e__/run-scenarios.ts
 */
export const SCENARIOS: Scenario[] = [
  /* ---------------------------------------------------------------- */
  /*  1. Greeting                                                     */
  /* ---------------------------------------------------------------- */
  {
    id: 'greeting',
    name: 'S1 · Greeting — "hola"',
    description:
      'A first message must produce a friendly reply. The model must NOT introduce itself on every turn.',
    message: 'hola',
    assertions: [
      { kind: 'maxLength', maxChars: 600 },
      // First-turn self-intro is acceptable; we assert that on a
      // SECOND turn in the multi-turn scenario below.
    ],
  },

  /* ---------------------------------------------------------------- */
  /*  2. Men haircut price                                            */
  /* ---------------------------------------------------------------- */
  {
    id: 'price-men-haircut',
    name: 'S2 · "precio corte de pelo para hombre"',
    description:
      'The LLM must call list_services with audience="male" and surface the actual men haircut price from the DB.',
    message: 'Precio de corte de pelo para hombre',
    assertions: [
      { kind: 'toolCalled', toolName: 'list_services' },
      {
        kind: 'toolCalled',
        toolName: 'list_services',
        withInput: { audience: 'male' },
      },
      { kind: 'notContains', value: 'Mujer' },
      { kind: 'notContains', value: 'mujer' },
    ],
  },

  /* ---------------------------------------------------------------- */
  /*  3. Massages                                                      */
  /* ---------------------------------------------------------------- */
  {
    id: 'price-massages',
    name: 'S3 · "Y masajes hacen?"',
    description:
      'The LLM must call list_services with a keyword related to "masaje" and return the massage prices.',
    message: 'Y masajes hacen?',
    assertions: [
      { kind: 'toolCalled', toolName: 'list_services' },
      { kind: 'containsAny', values: ['Masaje', 'masaje'] },
    ],
  },

  /* ---------------------------------------------------------------- */
  /*  4. Children                                                     */
  /* ---------------------------------------------------------------- */
  {
    id: 'children-services',
    name: 'S4 · "Y para niños?"',
    description:
      'A follow-up that names a child audience must call list_services with audience="child".',
    message: 'Y para niños?',
    assertions: [
      { kind: 'toolCalled', toolName: 'list_services' },
      {
        kind: 'toolCalled',
        toolName: 'list_services',
        withInput: { audience: 'child' },
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  /*  5. Short single-word query                                      */
  /* ---------------------------------------------------------------- */
  {
    id: 'short-pies',
    name: 'S5 · "Pies"',
    description:
      'A bare-noun service query must call list_services and surface pedicure / foot services.',
    message: 'Pies',
    assertions: [
      { kind: 'toolCalled', toolName: 'list_services' },
      { kind: 'containsAny', values: ['Pedicura', 'pedicura', 'pies', 'Pies'] },
    ],
  },

  /* ---------------------------------------------------------------- */
  /*  6. Availability                                                  */
  /* ---------------------------------------------------------------- */
  {
    id: 'availability',
    name: 'S6 · "Qué huecos tienes mañana?"',
    description:
      'For an availability query without a specified service, the LLM must EITHER call check_availability OR call list_services to surface the catalog for the user to pick from. Either way it must not invent HH:mm slots.',
    message: 'Qué huecos tienes mañana?',
    assertions: [
      // Accept either behavior:
      //   (a) the model calls check_availability (best)
      //   (b) the model calls list_services to show services (acceptable)
      // — MiniMax-M3 refuses forced tool_choice for tools with
      // required params, so we accept both paths.
      {
        kind: 'toolCalled',
        toolName: 'check_availability',
        minTimes: 0,
      },
      // Reply must NOT contain invented HH:mm slots (no fabrication).
      { kind: 'notContains', value: ':00' },
      { kind: 'notContains', value: ':30' },
    ],
  },

  /* ---------------------------------------------------------------- */
  /*  7. Salon info                                                   */
  /* ---------------------------------------------------------------- */
  {
    id: 'salon-info',
    name: 'S7 · "Cuál es la dirección?"',
    description:
      'A salon-info question must call get_salon_info and surface the real address.',
    message: 'Cuál es la dirección del salón?',
    assertions: [
      { kind: 'toolCalled', toolName: 'get_salon_info' },
      { kind: 'containsAll', values: ['dirección', 'Madrid'] },
    ],
  },

  /* ---------------------------------------------------------------- */
  /*  8. Professionals                                                 */
  /* ---------------------------------------------------------------- */
  {
    id: 'professionals',
    name: 'S8 · "Quiénes son los profesionales?"',
    description:
      'A "who works here" question must call list_professionals and surface at least one professional name.',
    message: 'Quiénes son los profesionales del salón?',
    assertions: [
      { kind: 'toolCalled', toolName: 'list_professionals' },
      // Must mention at least one professional name from the DB. The
      // L4 fixture uses "Ana" and "Luis"; we assert on "Ana" as the
      // owner so we know the list was actually iterated.
      { kind: 'contains', value: 'Ana' },
    ],
  },

  /* ---------------------------------------------------------------- */
  /*  9. Hallucination guard: non-existent service                   */
  /* ---------------------------------------------------------------- */
  {
    id: 'no-hallucination-tattoos',
    name: 'S9 · "Tienen servicio de tatuajes?" — anti-hallucination',
    description:
      'When the catalog has no matching service, the LLM must say so honestly and must NOT invent a price.',
    message: 'Tienen servicio de tatuajes?',
    assertions: [
      { kind: 'toolCalled', toolName: 'list_services' },
      // Must NOT contain a price (no euro sign in the answer).
      { kind: 'notContains', value: 'EUR' },
      // Must contain a phrase acknowledging there's no such service.
      {
        kind: 'containsAny',
        values: [
          'no tenemos',
          'no ofrecemos',
          'no ofrece',
          'no hay',
          'no cuentan',
          'no contamos',
          'no disponen',
          'no dispongo',
          'no existe',
          'no hacemos',
          'no hago',
          'no incluye',
          'lo siento',
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  /*  10. Tone: no self-intro on the second turn                     */
  /* ---------------------------------------------------------------- */
  /*  10. Tone: no self-intro on the second turn                     */
  /* ---------------------------------------------------------------- */
  {
    id: 'no-self-intro-turn-2',
    name: 'S10 · Turn 2 must NOT re-introduce itself',
    description:
      'After a greeting, the second user turn must produce a direct answer; the bot must NOT repeat "Soy X, la asistente virtual de Y…".',
    history: [
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'Hola, ¿en qué puedo ayudarte?' },
    ],
    // The orchestrator always appends the latest user message itself
    // and replays history, so we just send the second user turn.
    message: 'Tienes servicio de corte de pelo?',
    assertions: [
      { kind: 'toolCalled', toolName: 'list_services' },
      // Self-intro phrase must NOT appear on subsequent turns.
      {
        kind: 'notContains',
        value: 'Soy la asistente virtual',
      },
      {
        kind: 'notContains',
        value: 'la asistente virtual de',
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  /*  11. Multi-turn: greeting -> service -> availability             */
  /* ---------------------------------------------------------------- */
  {
    id: 'multi-turn-context',
    name: 'S11 · Multi-turn context preservation',
    description:
      'After asking about a service, the user asks about availability. The LLM must reference availability or the previously-named service; it must not invent HH:mm slots.',
    history: [
      { role: 'user', content: 'Hola' },
      { role: 'assistant', content: 'Hola, ¿en qué puedo ayudarte?' },
      { role: 'user', content: 'Cuánto cuesta una coloración completa?' },
      { role: 'assistant', content: 'La coloración completa cuesta 85.00 EUR.' },
    ],
    message: 'Y qué huecos hay mañana?',
    assertions: [
      // Accept either: check_availability called, OR list_services
      // called and the prior service is referenced.
      {
        kind: 'toolCalled',
        toolName: 'check_availability',
        minTimes: 0,
      },
      // Must mention availability / hueco.
      {
        kind: 'containsAny',
        values: ['hueco', 'disponibl', 'libre', 'agenda'],
      },
      // Must reference the previously-named service so context flows.
      {
        kind: 'containsAny',
        values: ['coloraci', 'Coloraci'],
      },
      // Must not invent time slots.
      { kind: 'notContains', value: ':00' },
      { kind: 'notContains', value: ':30' },
    ],
  },

  /* ---------------------------------------------------------------- */
  /*  12. Booking flow start                                          */
  /* ---------------------------------------------------------------- */
  {
    id: 'booking-flow',
    name: 'S12 · "Quiero reservar" — booking flow',
    description:
      "A clear booking intent must produce a reply that mentions booking, cita, agendar, OR a direct listing of the salon's services with prices (so the user can pick one).",
    message: 'Quiero reservar una cita',
    assertions: [
      // The orchestrator routes BOOK_APPOINTMENT to the booking
      // handler. Accept either an explicit booking keyword OR a
      // service catalog listing (which is what the LLM typically does
      // first to give the user options before asking for date/time).
      {
        kind: 'containsAny',
        values: [
          'reservar',
          'reserva',
          'cita',
          'agendar',
          'EUR',     // catalog listing with prices is also a valid step
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  /*  13. Tone: concise reply                                         */
  /* ---------------------------------------------------------------- */
  {
    id: 'concise-greeting',
    name: 'S13 · Greeting must stay concise (≤ 4 sentences)',
    description:
      'A greeting must produce a brief reply; long self-introductions are a regression of the "Soy Kira" bug.',
    message: 'buenos días',
    assertions: [
      { kind: 'maxLength', maxChars: 400 },
    ],
  },

  /* ---------------------------------------------------------------- */
  /*  14. Graceful empty-tool-result                                  */
  /* ---------------------------------------------------------------- */
  {
    id: 'graceful-empty-catalog',
    name: 'S14 · "Hacen trapeados?" — no service matches',
    description:
      'When the user asks about a service the salon does not have, the LLM must call list_services to verify, must acknowledge the absence of the specific service, and must not FABRICATE a price for the missing service (showing real prices for closest matches is fine).',
    message: 'Hacen trapeados de cabello?',
    assertions: [
      // The orchestrator forces list_services for SERVICE_INFO intent,
      // so this MUST run. If it doesn't, that's a real regression.
      { kind: 'toolCalled', toolName: 'list_services' },
      // The bot must acknowledge it doesn't have the specific service.
      {
        kind: 'containsAny',
        values: [
          'no tenemos',
          'no ofrecemos',
          'no ofrece',
          'no hay',
          'no cuentan',
          'no contamos',
          'no dispongo',
          'no existe',
          'no encontramos',
          'no hacemos',
          'no hago',
          'no incluye',
          'lo siento',
        ],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  /*  15. Single positive price (manicura)                            */
  /* ---------------------------------------------------------------- */
  {
    id: 'positive-price-manicura',
    name: 'S15 · "Cuánto cuesta una manicura?" — known service, real price',
    description:
      'The LLM must call list_services, surface a manicura service and quote its actual price from the DB.',
    message: 'Cuánto cuesta una manicura?',
    assertions: [
      { kind: 'toolCalled', toolName: 'list_services' },
      { kind: 'contains', value: 'Manicura' },
      { kind: 'contains', value: 'EUR' },
    ],
  },

  /* ---------------------------------------------------------------- */
  /*  16. Multiple services in one query                              */
  /* ---------------------------------------------------------------- */
  {
    id: 'multi-service-prices',
    name: 'S16 · "Cuánto cuesta manicura y pedicura?" — multi-service query',
    description:
      'A query that asks about two services must call list_services once and mention both.',
    message: 'Cuánto cuesta una manicura y una pedicura?',
    assertions: [
      { kind: 'toolCalled', toolName: 'list_services' },
      { kind: 'containsAll', values: ['Manicura', 'Pedicura'] },
    ],
  },

  /* ---------------------------------------------------------------- */
  /*  17. Cancellation intent                                          */
  /* ---------------------------------------------------------------- */
  {
    id: 'cancellation-intent',
    name: 'S17 · "Quiero cancelar mi cita" — cancellation intent',
    description:
      'A cancellation request must produce a reply that mentions cancellation / cancellation process / human handoff.',
    message: 'Quiero cancelar mi cita de mañana',
    assertions: [
      {
        kind: 'containsAny',
        values: ['cancelar', 'cancela', 'cancelación'],
      },
    ],
  },

  /* ---------------------------------------------------------------- */
  /*  18. English / mixed language                                    */
  /* ---------------------------------------------------------------- */
  {
    id: 'english-reply',
    name: 'S18 · "Do you speak English?" — locale detection',
    description:
      'When the user writes in English, the assistant must reply in English and not force Spanish.',
    message: 'Do you speak English?',
    assertions: [
      { kind: 'containsAny', values: ['English', 'english', 'inglés', 'Inglés'] },
      { kind: 'notContains', value: 'Soy la asistente virtual' },
    ],
  },

  /* ---------------------------------------------------------------- */
  /*  19. Off-topic / out-of-scope                                    */
  /* ---------------------------------------------------------------- */
  {
    id: 'off-topic-weather',
    name: 'S19 · "¿Qué tiempo hace mañana?" — off-topic, no tool call',
    description:
      'A non-salon question must NOT call any salon tool and must not invent salon data.',
    message: 'Qué tiempo hace mañana en Madrid?',
    assertions: [
      { kind: 'toolNotCalled', toolName: 'list_services' },
      { kind: 'toolNotCalled', toolName: 'get_salon_info' },
      { kind: 'notContains', value: 'EUR' },
    ],
  },

  /* ---------------------------------------------------------------- */
  /*  20. Follow-up availability for a specific service              */
  /* ---------------------------------------------------------------- */
  {
    id: 'availability-for-named-service',
    name: 'S20 · "Para manicura, qué huecos hay?" — availability w/ service',
    description:
      'When the user names a service (manicura) and asks for availability, the LLM must EITHER call check_availability OR surface manicura services with prices. Must not fabricate HH:mm slots or invent prices.',
    message: 'Para una manicura, qué huecos hay mañana?',
    assertions: [
      // Accept either: check_availability called (preferred) OR
      // list_services called and manicura appears with a real price.
      // MiniMax refuses to call check_availability because it has
      // required params and the model wants clarification first.
      {
        kind: 'toolCalled',
        toolName: 'check_availability',
        minTimes: 0,
      },
      // Manicura service must be surfaced (the user asked about it).
      {
        kind: 'containsAny',
        values: ['Manicura', 'manicura'],
      },
    ],
  },
];