const fetch = require('node-fetch'); // or native fetch if Node 18+
require('dotenv').config();

async function run() {
    const apiKey = process.env.GEMINI_API_KEY;
    const model = 'gemini-2.5-flash';
    const baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
    const url = `${baseUrl}/${model}:generateContent?key=${apiKey}`;

    const prompt = `Eres un clasificador de intenciones para un sistema de gestión de turnos de trabajo.

Responde ÚNICAMENTE con JSON válido, sin texto adicional:
{
  "intent": "<intent>",
  "confidence": <0.0-1.0>,
  "entities": {
    "date": <string|null>,
    "targetEmployeePhone": <string|null>,
    "shiftId": <string|null>,
    "reason": <string|null>,
    "weekStart": <string|null>
  },
  "transcription": null
}

Mensaje del empleado: "solo genera mi horario"`;

    const body = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { 
            temperature: 0.1, 
            maxOutputTokens: 512,
            responseMimeType: 'application/json'
        },
    });

    console.log("Requesting Gemini API...");
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
    });

    const json = await response.json();
    console.log(JSON.stringify(json, null, 2));
}

run().catch(console.error);
