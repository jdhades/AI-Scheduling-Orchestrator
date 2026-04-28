SELECT rule_text, structure
FROM semantic_rules
WHERE company_id = '10000000-0000-0000-0000-000000000001'
  AND is_active = true;
