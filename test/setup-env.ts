/**
 * Setup file para tests de integración y e2e.
 * Carga las variables de entorno de .env.test antes de ejecutar los tests.
 *
 * ✅ 12-Factor App: configuración fuera del código, en el entorno.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.test') });
