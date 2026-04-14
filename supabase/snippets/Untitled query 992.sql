SELECT id, rule_text, is_active, structure->>'intent' as intent,
       jsonb_pretty(structure) as struct
FROM semantic_rules
WHERE company_id = '10000000-0000-0000-0000-000000000001'
  AND is_active = true
ORDER BY created_at;

