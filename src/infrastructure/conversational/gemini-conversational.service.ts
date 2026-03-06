import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
    IConversationalService,
} from '../../domain/services/conversational.service.interface';
import {
    ConversationIntentVO,
    IntentEntities,
    IntentType,
} from '../../domain/value-objects/conversation-intent.vo';

/**
 * GeminiConversationalService — Adapter for IConversationalService
 *
 * Handles both text and audio messages using a single Gemini API key.
 *
 * Text → Gemini 1.5 Flash (low latency, classification only)
 * Audio → Gemini 1.5 Pro (better multimodal comprehension)
 *         Downloads audio from Twilio with Basic Auth, sends inline as base64
 *
 * Clean Architecture:
 *   - Lives in infrastructure (knows Gemini exists)
 *   - Domain only knows IConversationalService
 */
@Injectable()
export class GeminiConversationalService implements IConversationalService {
    private readonly logger = new Logger(GeminiConversationalService.name);
    private readonly apiKey: string;
    private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';

    private static readonly TEXT_MODEL = 'gemini-1.5-flash';
    private static readonly AUDIO_MODEL = 'gemini-1.5-pro';
    private static readonly TEXT_TIMEOUT_MS = 10_000;
    private static readonly AUDIO_TIMEOUT_MS = 30_000;

    constructor(private readonly config: ConfigService) {
        this.apiKey = this.config.getOrThrow<string>('gemini.apiKey');
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    async processText(text: string): Promise<ConversationIntentVO> {
        const prompt = this.buildTextPrompt(text);
        try {
            const raw = await this._callGemini(
                GeminiConversationalService.TEXT_MODEL,
                [{ text: prompt }],
                GeminiConversationalService.TEXT_TIMEOUT_MS,
            );
            return this._parseResponse(raw, text);
        } catch (err) {
            this.logger.error(`[processText] Gemini call failed: ${(err as Error).message}`);
            return ConversationIntentVO.unknown(text);
        }
    }

    async processAudio(
        audioUrl: string,
        mimeType: string,
        twilioSid: string,
        twilioToken: string,
    ): Promise<ConversationIntentVO> {
        // 1. Download audio from Twilio (requires Basic Auth)
        let audioBase64: string;
        try {
            audioBase64 = await this._downloadAudioAsBase64(audioUrl, twilioSid, twilioToken);
        } catch (err) {
            this.logger.error(`[processAudio] Download failed: ${(err as Error).message}`);
            return ConversationIntentVO.unknown('');
        }

        // 2. Send audio inline to Gemini 1.5 Pro
        const prompt = this.buildAudioPrompt();
        try {
            const raw = await this._callGemini(
                GeminiConversationalService.AUDIO_MODEL,
                [
                    { inlineData: { mimeType, data: audioBase64 } },
                    { text: prompt },
                ],
                GeminiConversationalService.AUDIO_TIMEOUT_MS,
            );
            return this._parseResponse(raw, '');
        } catch (err) {
            this.logger.error(`[processAudio] Gemini call failed: ${(err as Error).message}`);
            return ConversationIntentVO.unknown('');
        }
    }

    // ─── Prompts ──────────────────────────────────────────────────────────────

    private buildTextPrompt(text: string): string {
        return `Eres un clasificador de intenciones para un sistema de gestión de turnos de trabajo.
Analiza el siguiente mensaje de un empleado y extrae la intención y entidades relevantes.

INTENCIONES DISPONIBLES:
- swap_shift: el empleado quiere intercambiar su turno con otro
- report_absence: el empleado no puede asistir a su turno
- check_schedule: el empleado quiere ver su horario
- request_day_off: el empleado solicita un día libre
- generate_schedule: el manager quiere generar el horario de la semana (frases como "genera el horario", "crea los turnos", "planifica la semana que viene")
- unknown: la intención no es clara o no corresponde a ninguna de las anteriores

ENTIDADES A EXTRAER (pon null si no se menciona):
- date: fecha del turno en formato YYYY-MM-DD si se menciona
- targetEmployeePhone: número de teléfono del compañero con prefijo + si se menciona
- shiftId: ID del turno si se menciona explícitamente
- reason: motivo de la ausencia o solicitud (texto libre)
- weekStart: primer día de la semana (lunes) en formato YYYY-MM-DD, solo para generate_schedule

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

Mensaje del empleado: "${text.replace(/"/g, '\\"')}"`;
    }

    private buildAudioPrompt(): string {
        return `Eres un clasificador de intenciones para un sistema de gestión de turnos de trabajo.
El archivo de audio adjunto contiene un mensaje de un empleado.

Primero transcribe el audio fielmente. Luego clasifica la intención y extrae entidades.

INTENCIONES DISPONIBLES:
- swap_shift: el empleado quiere intercambiar su turno con otro
- report_absence: el empleado no puede asistir a su turno
- check_schedule: el empleado quiere ver su horario
- request_day_off: el empleado solicita un día libre
- generate_schedule: el manager quiere generar el horario de la semana
- unknown: la intención no es clara o no corresponde a ninguna de las anteriores

ENTIDADES A EXTRAER (pon null si no se menciona):
- date: fecha del turno en formato YYYY-MM-DD si se menciona
- targetEmployeePhone: número de teléfono del compañero con prefijo + si se menciona
- shiftId: ID del turno si se menciona explícitamente
- reason: motivo de la ausencia o solicitud (texto libre)
- weekStart: primer día de la semana (lunes) en formato YYYY-MM-DD, solo para generate_schedule

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
  "transcription": "<transcripcion del audio>"
}`;
    }

    // ─── HTTP helper ──────────────────────────────────────────────────────────

    private async _callGemini(
        model: string,
        parts: unknown[],
        timeoutMs: number,
    ): Promise<string> {
        const url = `${this.baseUrl}/${model}:generateContent?key=${this.apiKey}`;
        const body = JSON.stringify({
            contents: [{ parts }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
        });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let response: Response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Gemini API error ${response.status}: ${errorText}`);
        }

        const json = await response.json() as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };

        const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('Empty response from Gemini');
        return text;
    }

    private async _downloadAudioAsBase64(
        audioUrl: string,
        twilioSid: string,
        twilioToken: string,
    ): Promise<string> {
        const credentials = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
        const response = await fetch(audioUrl, {
            headers: { Authorization: `Basic ${credentials}` },
        });

        if (!response.ok) {
            throw new Error(`Failed to download audio from Twilio: ${response.status}`);
        }

        const buffer = await response.arrayBuffer();
        return Buffer.from(buffer).toString('base64');
    }

    // ─── Response parser ──────────────────────────────────────────────────────

    private _parseResponse(raw: string, fallbackRawText: string): ConversationIntentVO {
        try {
            // Extract JSON even if Gemini wraps it in markdown code blocks
            const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? [null, raw];
            const jsonStr = (jsonMatch[1] ?? raw).trim();
            const data = JSON.parse(jsonStr) as {
                intent?: string;
                confidence?: number;
                entities?: IntentEntities;
                transcription?: string;
            };

            const intent = (data.intent ?? 'unknown') as IntentType;
            const confidence = Math.min(1, Math.max(0, data.confidence ?? 0));
            const rawText = data.transcription ?? fallbackRawText;

            // Validate intent is one of the allowed values
            const validIntents: IntentType[] = [
                'swap_shift', 'report_absence', 'check_schedule', 'request_day_off', 'generate_schedule', 'unknown',
            ];
            if (!validIntents.includes(intent)) {
                return ConversationIntentVO.unknown(rawText);
            }

            // Filter out null entity values
            const entities: IntentEntities = {};
            if (data.entities) {
                for (const [k, v] of Object.entries(data.entities)) {
                    if (v !== null && v !== undefined) {
                        (entities as Record<string, string>)[k] = v as string;
                    }
                }
            }

            return ConversationIntentVO.create({ intent, confidence, entities, rawText });
        } catch (err) {
            this.logger.warn(`[_parseResponse] Could not parse Gemini JSON: ${(err as Error).message}`);
            return ConversationIntentVO.unknown(fallbackRawText);
        }
    }
}
