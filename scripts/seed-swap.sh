#!/bin/bash
COMPANY_ID="11111111-2222-3333-4444-555555555555"
UUID1=$(uuidgen)
UUID2=$(uuidgen)
UUID3=$(uuidgen)
ASSIGN1=$(uuidgen)
ASSIGN2=$(uuidgen)

URL="http://127.0.0.1:54321"
KEY="REDACTED_SUPABASE_SECRET"

# Get user IDs
EMPLOYEES=$(curl -s -X GET "$URL/rest/v1/employees?company_id=eq.$COMPANY_ID" -H "apikey: $KEY" -H "Authorization: Bearer $KEY")
USER_ID=$(echo $EMPLOYEES | grep -o '"id":"[^"]*' | head -1 | cut -d '"' -f 4)
COLL_ID=$(echo $EMPLOYEES | grep -o '"id":"[^"]*' | sed -n '2p' | cut -d '"' -f 4)

if [ -z "$USER_ID" ]; then
  echo "Error: No employees found. Please run seed-scenario-data.js first."
  exit 1
fi

TOMORROW=$(date -d "+1 day" +"%Y-%m-%d")
DAY_AFTER=$(date -d "+2 days" +"%Y-%m-%d")
DAY_3=$(date -d "+3 days" +"%Y-%m-%d")

# Insert Shifts
curl -s -X POST "$URL/rest/v1/shifts" \
-H "apikey: $KEY" \
-H "Authorization: Bearer $KEY" \
-H "Content-Type: application/json" \
-H "Prefer: return=minimal" \
-d "[
  {\"id\": \"$UUID1\", \"company_id\": \"$COMPANY_ID\", \"start_time\": \"${TOMORROW}T08:00:00Z\", \"end_time\": \"${TOMORROW}T16:00:00Z\", \"required_skill_level\": \"junior\", \"required_experience_months\": 0, \"demand_score\": 1, \"undesirable_weight\": 1},
  {\"id\": \"$UUID2\", \"company_id\": \"$COMPANY_ID\", \"start_time\": \"${DAY_AFTER}T12:00:00Z\", \"end_time\": \"${DAY_AFTER}T20:00:00Z\", \"required_skill_level\": \"junior\", \"required_experience_months\": 0, \"demand_score\": 1, \"undesirable_weight\": 1},
  {\"id\": \"$UUID3\", \"company_id\": \"$COMPANY_ID\", \"start_time\": \"${DAY_3}T10:00:00Z\", \"end_time\": \"${DAY_3}T18:00:00Z\", \"required_skill_level\": \"junior\", \"required_experience_months\": 0, \"demand_score\": 1, \"undesirable_weight\": 1}
]" > /dev/null

# Insert Assignments
curl -s -X POST "$URL/rest/v1/shift_assignments" \
-H "apikey: $KEY" \
-H "Authorization: Bearer $KEY" \
-H "Content-Type: application/json" \
-H "Prefer: return=minimal" \
-d "[
  {\"id\": \"$ASSIGN1\", \"shift_id\": \"$UUID1\", \"employee_id\": \"$USER_ID\", \"company_id\": \"$COMPANY_ID\", \"assigned_at\": \"$(date -Iseconds)\", \"assigned_by_strategy\": \"manual\", \"fairness_snapshot\": {}},
  {\"id\": \"$ASSIGN2\", \"shift_id\": \"$UUID2\", \"employee_id\": \"$COLL_ID\", \"company_id\": \"$COMPANY_ID\", \"assigned_at\": \"$(date -Iseconds)\", \"assigned_by_strategy\": \"manual\", \"fairness_snapshot\": {}}
]" > /dev/null

echo "✅ Shifs and Assignments seeded directly via cURL!"
