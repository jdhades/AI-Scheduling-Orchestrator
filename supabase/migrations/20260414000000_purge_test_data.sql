-- =============================================================================
-- MIGRATION: purge all test data before shift model rework
-- Empieza desde cero para evitar inconsistencias con el modelo nuevo.
-- Orden FK-safe: de entidades dependientes hacia entidades raíz.
-- =============================================================================

-- Assignments y reportes
DELETE FROM shift_assignments;
DELETE FROM shift_swap_requests;
DELETE FROM absence_reports;

-- Shifts instanciados + templates
DELETE FROM shifts;
DELETE FROM shift_templates;

-- Reglas semánticas
DELETE FROM semantic_rules;

-- Employee-related
DELETE FROM employee_skills;
DELETE FROM employee_availability;
DELETE FROM employee_preferences;
DELETE FROM employees;

-- Estructura organizacional
DELETE FROM departments;
DELETE FROM branches;
DELETE FROM company_skills;

-- Fairness history y tablas de auditoría
DELETE FROM fairness_history;

-- Companies (última porque todo apunta acá)
DELETE FROM companies;
