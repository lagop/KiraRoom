# L-1 end-to-end scenarios for the Virtual Receptionist

Real-world scenarios that drive the **live MiniMax-M3** model against
the real database. Each scenario has hard assertions on:

- which tools the model called,
- what substrings appear (or must NOT appear) in the reply,
- that the assistant stays concise and in-scope.

The suite is **gated** so it never runs in regular CI: you must opt in
with `RUN_LLM_E2E_TESTS=1` and provide a fresh `MINIMAX_API_KEY`.

## Run via Jest

```bash
cd packages/backend
$env:RUN_LLM_E2E_TESTS="1"
$env:MINIMAX_API_KEY="sk-cp-..."   # a fresh key, NOT the one shared in chat
$env:DATABASE_URL="postgresql://..."
npm run test:e2e:llm
```

Equivalent on bash:

```bash
RUN_LLM_E2E_TESTS=1 \
MINIMAX_API_KEY=sk-cp-... \
DATABASE_URL=postgresql://... \
npm run test:e2e:llm
```

Filter scenarios:

```bash
# Run only the hallucination guards:
E2E_ONLY=no-hallucination-tattoos,graceful-empty-catalog npm run test:e2e:llm

# Run just one scenario:
E2E_ONLY=price-men-haircut npm run test:e2e:llm
```

## Run via CLI (faster, prettier output, no Jest overhead)

```bash
npm run run:e2e:llm
```

The CLI also accepts:

- `E2E_ONLY=<csv>` — only run these scenario ids
- `E2E_BAIL=0` — keep running after a failure (default: stop on first)
- `E2E_TIMEOUT_MS=30000` — per-scenario timeout (default: 30s)
- `E2E_TENANT_ID=<uuid>` — which tenant to use (default: `e2e-tenant`,
  falls back to the first tenant in the DB)

## What is checked

| Scenario | Verifies |
|---|---|
| `greeting` | First message is friendly, ≤ 600 chars |
| `price-men-haircut` | `list_services(audience="male")` called, no women-only services mentioned |
| `price-massages` | `list_services` called, massage services surface |
| `children-services` | `list_services(audience="child")` called |
| `short-pies` | `list_services` called, pedicura / pies mentioned |
| `availability` | `check_availability` called, time-shaped token present |
| `salon-info` | `get_salon_info` called, real address appears |
| `professionals` | `list_professionals` called, at least one real name |
| `no-hallucination-tattoos` | `list_services` called, **no EUR** in reply, "no tenemos" or similar |
| `no-self-intro-turn-2` | `list_services` called, **no "Soy la asistente virtual de…"** |
| `multi-turn-context` | After service question, `check_availability` runs for the same service |
| `booking-flow` | "Quiero reservar" surfaces booking vocabulary |
| `concise-greeting` | "buenos días" reply ≤ 400 chars |
| `graceful-empty-catalog` | Unknown service → no price invented, "no tenemos" appears |
| `positive-price-manicura` | Real manicura price from DB |
| `multi-service-prices` | "manicura y pedicura" surfaces both names |
| `cancellation-intent` | "Quiero cancelar" mentions cancellation |
| `english-reply` | English input → English reply |
| `off-topic-weather` | Off-topic question → no salon tool called, no EUR |
| `availability-for-named-service` | "Para manicura, qué huecos hay?" → `check_availability` |

## Adding a new scenario

Append an entry to `scenarios.ts`:

```typescript
{
  id: 'my-scenario',
  name: 'S21 · "My new scenario"',
  description: 'What this verifies',
  message: 'user input',
  assertions: [
    { kind: 'toolCalled', toolName: 'list_services' },
    { kind: 'contains', value: 'expected substring' },
    { kind: 'notContains', value: 'forbidden substring' },
  ],
},
```

Assertion kinds:

| Kind | Behaviour |
|---|---|
| `contains` | Reply must contain this substring (case-insensitive unless `caseSensitive: true`) |
| `containsAny` | Reply must contain at least one of the values |
| `containsAll` | Reply must contain every value |
| `notContains` | Reply must NOT contain this substring |
| `toolCalled` | Tool `toolName` must have been called; optional `minTimes`, `withInput` shape match |
| `toolNotCalled` | Tool `toolName` must NOT have been called |
| `intent` | `analysis.intent` matches |
| `provider` | Response `provider` matches |
| `priceFromCatalog` | Every `{name, price}` pair appears verbatim in the reply |
| `maxLength` | Reply length ≤ `maxChars` |

## Cost / latency budget

- 20 scenarios × ~3s average per scenario ≈ 60s end-to-end.
- Tokens burned depend on tool calls; expect 2-6k tokens per scenario on
  average (~$0.01 per scenario at M3 pricing).
- A nightly run against this suite is in the order of **$0.20 / day**.

## Caveats

- LLM replies are non-deterministic — assertions use substrings, not
  exact matches. The suite is designed to catch *regressions* (e.g. price
  fabrication, wrong tool) not stylistic drift.
- Some scenarios pin DB-dependent substrings (e.g. "Ana" for the
  professional). If your test tenant doesn't have a professional named
  "Ana", scenario `professionals` will fail. Either seed a test tenant
  with the expected fixtures or update the assertions.
- The harness relies on `MessageResponseDto.toolsExecuted` being
  populated by `MiniMaxProvider.generateCompletion`. If you change the
  field name, update the harness's `runScenario` accordingly.