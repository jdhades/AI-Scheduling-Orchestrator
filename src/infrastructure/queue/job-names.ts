/**
 * Job names para pg-boss. Centralizar acá evita typos sueltos en el
 * codebase. Nuevos jobs: agregar la constante, definir el payload en
 * types.ts y registrar el handler en el módulo.
 */
export const JOB_SCHEDULE_GENERATE = 'schedule.generate';

/**
 * Dead-letter queue para `schedule.generate`. pg-boss copia el
 * payload acá cuando se exhaustan los retries del job principal.
 * El worker dedicado notifica al manager (Twilio outbound) y loguea.
 */
export const JOB_SCHEDULE_GENERATE_DEAD = 'schedule.generate.dead';
