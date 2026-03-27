import { Client } from 'pg';

/**
 * 🧪 INTEGRATION TEST: PostgreSQL Direct Connection
 *
 * Este test verifica que podemos conectarnos directamente a la base de datos
 * PostgreSQL local de Supabase usando el cliente `pg`.
 *
 * ✅ Buenas prácticas aplicadas:
 * - Variables de entorno via process.env (12-Factor App) — no hardcoded
 * - beforeAll / afterAll para conectar/desconectar UNA sola vez (eficiente)
 * - Test que ejecuta una query real para confirmar la conexión
 *
 * ⚠️ Requires: npx supabase start (local instance running on port 54322)
 */
describe('PostgreSQL Direct Connection', () => {
  let client: Client;

  beforeAll(async () => {
    // Las credenciales vienen de .env.test cargado por Jest
    // NUNCA hardcodear connection strings en los tests
    client = new Client({
      connectionString: process.env.DATABASE_URL,
    });
    await client.connect();
  });

  afterAll(async () => {
    // Siempre cerrar la conexión al final para no dejar recursos abiertos
    if (client) {
      await client.end();
    }
  });

  it('should connect successfully to the local PostgreSQL instance', async () => {
    // Si llegamos aquí sin error, la conexión fue exitosa (el beforeAll no lanzó)
    expect(client).toBeDefined();
  });

  it('should execute a simple SELECT 1 query', async () => {
    const result = await client.query('SELECT 1 AS value');

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].value).toBe(1);
  });

  it('should retrieve the PostgreSQL server version', async () => {
    const result = await client.query('SELECT version()');

    expect(result.rows).toHaveLength(1);
    // Verificamos que la respuesta de versión contiene 'PostgreSQL'
    expect(result.rows[0].version).toMatch(/PostgreSQL/i);
  });

  it('should list tables in the public schema', async () => {
    const result = await client.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            ORDER BY table_name
        `);

    // No requiere tablas específicas, solo que la query se ejecute sin error
    expect(Array.isArray(result.rows)).toBe(true);
  });
});
