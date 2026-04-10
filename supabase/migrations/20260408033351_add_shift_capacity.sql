-- Add required_employees to shift_templates and shifts to support Elastic Shift Capacity
-- An null required_employees indicates that capacity is dynamic (i.e., LLM distributes employees equitably based on roster)

ALTER TABLE shift_templates
  ADD COLUMN IF NOT EXISTS required_employees INTEGER NULL DEFAULT NULL;

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS required_employees INTEGER NULL DEFAULT NULL;
