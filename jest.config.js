require('dotenv').config({ path: '.env.test' });

/**
 * Configuración de Jest para el proyecto ai-scheduling-orchestrator.
 *
 * Proyectos separados por tipo de test:
 *  - unit: tests del domain layer, rápidos, sin red/DB
 *  - integration: tests contra Supabase/PostgreSQL local (require supabase start)
 *
 * Las variables de entorno se cargan desde .env.test al inicio de cada suite.
 */
module.exports = {
    // Carga .env.test antes de cualquier test
    // Esto garantiza que process.env.DATABASE_URL, SUPABASE_URL, etc. estén disponibles
    globalSetup: undefined,

    projects: [
        {
            displayName: 'unit',
            moduleFileExtensions: ['js', 'json', 'ts'],
            testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
            transform: {
                '^.+\\.(t|j)s$': 'ts-jest',
            },
            testEnvironment: 'node',
            // Unit tests NO cargan .env.test — no necesitan variables de entorno
        },
        {
            displayName: 'integration',
            moduleFileExtensions: ['js', 'json', 'ts'],
            testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
            transform: {
                '^.+\\.(t|j)s$': 'ts-jest',
            },
            testEnvironment: 'node',
            // Integration tests SÍ cargan .env.test para DB/Supabase/Redis
            setupFiles: ['<rootDir>/test/setup-env.ts'],
        },
    ],

    // Coverage global (aplica a ambos proyectos)
    collectCoverageFrom: ['src/**/*.(t|j)s'],
    coverageDirectory: './coverage',
    coveragePathIgnorePatterns: [
        '/node_modules/',
        '/dist/',
        'main.ts',
        '.module.ts',
    ],
};