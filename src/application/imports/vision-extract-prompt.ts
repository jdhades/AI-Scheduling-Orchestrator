/**
 * Prompt para extraer ImportPayload desde un PDF/imagen.
 *
 * El prompt es portable entre providers — la única diferencia es cómo
 * se adjunta el archivo (content block image/document). El payload
 * shape se describe en términos del schema canónico v1.0.0 (ver
 * `import-payload.types.ts`).
 *
 * Decisiones de diseño:
 *   - Pedimos JSON puro entre marcadores `<json>...</json>` para que
 *     el parser pueda extraerlo sin importar el preámbulo del modelo.
 *   - `externalId` lo genera el modelo — basta con que sea único en el
 *     payload (e1, r1, b1, etc.).
 *   - `confidence` por entidad — bajo (<0.6) si la imagen está borrosa
 *     o el dato se infirió, alto (>0.9) si está escrito explícito.
 *   - Anti-hallucination: "si no está en el archivo, omitilo. Mejor
 *     warning que inventar".
 */
export const VISION_EXTRACT_SYSTEM_PROMPT = `Sos un extractor de datos para un sistema de scheduling de personal. Recibís un archivo (PDF o imagen) con información sobre empleados, turnos, sucursales, departamentos, roles, disponibilidad, descansos o ausencias, y devolvés un JSON con la información extraída en el schema canónico v1.0.0 del sistema.

Reglas inviolables:
1. **No inventes datos.** Si un campo no está en el archivo, omitilo (undefined). Mejor un warning que un valor falso.
2. **externalId único por entidad.** Generá ids cortos y memotécnicos (e1, e2, r1, b1, d1...).
3. **confidence 0..1 por entidad.** 0.95+ si está literal en el archivo, 0.7-0.9 si se infirió razonablemente, <0.6 si dudaste.
4. **Referencias por externalId.** Si un empleado tiene rol "Cajero", creá un ImportRole con externalId "r1" y referencialo desde el employee con roleExternalIds: ["r1"]. Lo mismo para sucursales y departamentos.
5. **Fechas en ISO YYYY-MM-DD.** Horas en HH:mm 24h.
6. **Teléfonos en E.164** ("+5491155555555"). Si no podés normalizar, ponelo en warnings y omitilo.
7. **Warnings** para datos ambiguos: "email inválido para Juan Pérez", "horario solapado en e3", etc. severity ∈ {info, warn, error}.
8. **JSON puro entre <json>...</json>**. Sin markdown, sin código, sin explicaciones por fuera.

Entidades del schema (todas opcionales en data):
- locations[]: { externalId, name, timezone?, confidence? }
- departments[]: { externalId, name, locationExternalId?, managerEmployeeExternalId?, confidence? }
- roles[]: { externalId, name, confidence? }
- employees[]: { externalId, name, email?, phone?, hireDate?, employmentType?, payRate?, departmentExternalId?, roleExternalIds?[], experienceMonths?, confidence? }
- shifts[]: { externalId, employeeExternalId?, date, startTime, endTime, crossesMidnight, locationExternalId?, departmentExternalId?, requiredRoleExternalId?, confidence? }
- availability[]: { externalId, employeeExternalId, dayOfWeek (0=Sun..6=Sat), windows: [{startTime, endTime, available}], effectiveFrom?, effectiveUntil?, confidence? }
- breaks[]: { externalId, scope: 'policy_global'|'policy_role'|'shift_specific', triggerAfterMinutesWorked?, durationMinutes, isPaid, roleExternalId?, shiftExternalId?, confidence? }
- timeOff[]: { externalId, employeeExternalId, startDate, endDate, type: 'vacation'|'sick'|'personal'|'unpaid'|'other', reason?, status: 'approved'|'pending'|'rejected', confidence? }

employmentType ∈ {full_time, part_time, contractor, intern}
payRate = { amount, currency (ISO 4217), period: 'hour'|'week'|'month' }`;

export const VISION_EXTRACT_USER_PROMPT = `Extraé toda la información de scheduling del archivo adjunto al schema canónico. Confianza global del lote en sourceMetadata.confidence (0..1). Devolvé EXACTAMENTE este shape envuelto en <json></json>:

<json>
{
  "schemaVersion": "1.0.0",
  "source": "upload_freeform",
  "sourceMetadata": {
    "extractedAt": "ISO 8601 datetime de ahora",
    "agentName": "<provider-y-modelo>",
    "confidence": 0..1
  },
  "data": {
    "locations": [],
    "departments": [],
    "roles": [],
    "employees": [],
    "shifts": [],
    "availability": [],
    "breaks": [],
    "timeOff": []
  },
  "warnings": []
}
</json>

Solo incluí los arrays de data que tengan al menos 1 entidad. Si el archivo NO tiene info de scheduling, devolvé el schema con data: {} y un warning severity='error' explicando qué viste.`;

/**
 * Extrae el JSON entre los marcadores `<json>...</json>` del output
 * del modelo. Si no encuentra el marcador, intenta parsear el primer
 * bloque \`\`\`json ... \`\`\` o el texto entero. Devuelve `null` si nada
 * parsea — el caller emite VisionExtractError.
 */
export function extractJsonFromOutput(raw: string): unknown | null {
  const trimmed = raw.trim();

  // Caso 1: <json>...</json>
  const tagMatch = trimmed.match(/<json>([\s\S]*?)<\/json>/i);
  if (tagMatch) {
    try {
      return JSON.parse(tagMatch[1].trim());
    } catch {
      /* fallthrough */
    }
  }

  // Caso 2: ```json ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      /* fallthrough */
    }
  }

  // Caso 3: el texto entero parsea
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
