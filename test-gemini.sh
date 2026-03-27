#!/bin/bash
source .env
curl -s "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$GEMINI_API_KEY" \
-H 'Content-Type: application/json' \
-X POST \
-d '{
  "contents": [{
    "parts": [{
      "text": "Eres un clasificador de intenciones para un sistema de gestión de turnos de trabajo.\n\nResponde ÚNICAMENTE con JSON válido, sin texto adicional:\n{\n  \"intent\": \"<intent>\",\n  \"confidence\": <0.0-1.0>,\n  \"entities\": {\n    \"date\": <string|null>,\n    \"targetEmployeePhone\": <string|null>,\n    \"shiftId\": <string|null>,\n    \"reason\": <string|null>,\n    \"weekStart\": <string|null>\n  },\n  \"transcription\": null\n}\n\nMensaje del empleado: \"solo genera mi horario\""
    }]
  }],
  "generationConfig": {
    "temperature": 0.1,
    "maxOutputTokens": 512,
    "responseMimeType": "application/json"
  }
}' > test-gemini-output.json
