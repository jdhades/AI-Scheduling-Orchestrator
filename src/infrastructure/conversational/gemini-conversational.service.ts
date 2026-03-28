import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IConversationalService } from '../../domain/services/conversational.service.interface';
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
  private readonly baseUrl =
    'https://generativelanguage.googleapis.com/v1beta/models';

  private static readonly TEXT_MODEL = 'gemini-2.5-flash';
  private static readonly AUDIO_MODEL = 'gemini-2.5-flash';
  private static readonly TEXT_TIMEOUT_MS = 30_000;
  private static readonly AUDIO_TIMEOUT_MS = 60_000;

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
      this.logger.error(
        `[processText] Gemini call failed: ${(err as Error).message}`,
      );
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
      audioBase64 = await this._downloadAudioAsBase64(
        audioUrl,
        twilioSid,
        twilioToken,
      );
    } catch (err) {
      this.logger.error(
        `[processAudio] Download failed: ${(err as Error).message}`,
      );
      return ConversationIntentVO.unknown('(error descargando audio)');
    }

    // 2. Send audio inline to Gemini 1.5 Pro
    const prompt = this.buildAudioPrompt();
    try {
      const raw = await this._callGemini(
        GeminiConversationalService.AUDIO_MODEL,
        [{ inlineData: { mimeType, data: audioBase64 } }, { text: prompt }],
        GeminiConversationalService.AUDIO_TIMEOUT_MS,
      );
      return this._parseResponse(raw, '(audio no transcrito)');
    } catch (err) {
      this.logger.error(
        `[processAudio] Gemini call failed: ${(err as Error).message}`,
      );
      return ConversationIntentVO.unknown('(error procesando audio)');
    }
  }

  // ─── Prompts ──────────────────────────────────────────────────────────────

  private buildTextPrompt(text: string): string {
    const today = new Date().toISOString().split('T')[0];
    return `Eres un clasificador de intenciones para un sistema de gestión de turnos de trabajo.
Hoy es ${today}.
Analiza el siguiente mensaje de un empleado (que puede estar en español, inglés u otro idioma) y extrae la intención y entidades relevantes.

INTENCIONES DISPONIBLES:
- swap_shift: el empleado quiere intercambiar su turno con otro
- report_absence: el empleado no puede asistir a su turno
- check_schedule: el empleado quiere ver su horario
- request_day_off: el empleado solicita un día libre
- generate_schedule: el manager quiere generar el horario de la semana (frases como "genera el horario", "crea los turnos", "planifica la semana que viene")
- select_option: el usuario está seleccionando una opción de una lista (ej. "el número 1", "opción 2") o respondiendo (ej. "sí", "no")
- unknown: la intención no es clara o no corresponde a ninguna de las anteriores

ENTIDADES A EXTRAER (pon null si no se menciona):
- date: fecha del turno en formato YYYY-MM-DD si se menciona
- targetEmployeePhone: número de teléfono del compañero con prefijo + si se menciona
- shiftId: ID del turno si se menciona explícitamente
- reason: motivo de la ausencia o solicitud (texto libre)
- weekStart: primer día de la semana (lunes) en formato YYYY-MM-DD si el usuario pregunta por una semana en particular
- timeOfDay: momento del día (ej. "morning", "afternoon", "night") si se menciona para la ausencia
- selection: opción seleccionada (ej. "1", "2", "yes", "no") si la intención es select_option

Responde ÚNICAMENTE con JSON válido, sin texto adicional:
{
  "intent": "<intent>",
  "confidence": <0.0-1.0>,
  "entities": {
    "date": <string|null>,
    "targetEmployeePhone": <string|null>,
    "shiftId": <string|null>,
    "reason": <string|null>,
    "weekStart": <string|null>,
    "timeOfDay": <string|null>,
    "selection": <string|null>
  },
  "transcription": null
}

Mensaje del empleado: "${text.replace(/"/g, '\\"')}"`;
  }

  private buildAudioPrompt(): string {
    const today = new Date().toISOString().split('T')[0];
    return `Eres un clasificador de intenciones para un sistema de gestión de turnos de trabajo.
Hoy es ${today}.
El archivo de audio adjunto contiene un mensaje de un empleado o manager (que puede estar en español, inglés u otro idioma).

Primero transcribe el audio fielmente (en su idioma original). Luego clasifica la intención y extrae entidades.

INTENCIONES DISPONIBLES:
- swap_shift: el empleado quiere intercambiar su turno con otro
- report_absence: el empleado no puede asistir a su turno
- check_schedule: el empleado quiere ver su horario
- request_day_off: el empleado solicita un día libre
- generate_schedule: el manager quiere generar el horario de la semana (frases como "genera el horario", "crea los turnos", "planifica la semana")
- select_option: el usuario está seleccionando una opción de una lista (ej. "el número 1", "opción 2") o respondiendo (ej. "sí", "no")
- unknown: la intención no es clara o no corresponde a ninguna de las anteriores

ENTIDADES A EXTRAER (pon null si no se menciona):
- date: fecha del turno en formato YYYY-MM-DD si se menciona
- targetEmployeePhone: número de teléfono del compañero con prefijo + si se menciona
- shiftId: ID del turno si se menciona explícitamente
- reason: motivo de la ausencia o solicitud (texto libre)
- weekStart: primer día de la semana (lunes) en formato YYYY-MM-DD si el usuario pregunta por una semana en particular
- timeOfDay: momento del día (ej. "morning", "afternoon", "night") si se menciona para la ausencia
- selection: opción seleccionada (ej. "1", "2", "yes", "no") si la intención es select_option

Responde ÚNICAMENTE con JSON válido, sin texto adicional:
{
  "intent": "<intent>",
  "confidence": <0.0-1.0>,
  "entities": {
    "date": <string|null>,
    "targetEmployeePhone": <string|null>,
    "shiftId": <string|null>,
    "reason": <string|null>,
    "weekStart": <string|null>,
    "timeOfDay": <string|null>,
    "selection": <string|null>
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
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
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

    const json = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
    };

    this.logger.debug(
      `[Gemini API] FULL RAW NETWORK RESPONSE: ${JSON.stringify(json)}`,
    );

    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty response from Gemini');
    return text;
  }

  private async _downloadAudioAsBase64(
    audioUrl: string,
    twilioSid: string,
    twilioToken: string,
  ): Promise<string> {
    const credentials = Buffer.from(`${twilioSid}:${twilioToken}`).toString(
      'base64',
    );
    const response = await fetch(audioUrl, {
      headers: { Authorization: `Basic ${credentials}` },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to download audio from Twilio: ${response.status}`,
      );
    }

    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
  }

  // ─── Response parser ──────────────────────────────────────────────────────

  private _parseResponse(
    raw: string,
    fallbackRawText: string,
  ): ConversationIntentVO {
    try {
      // Aggressive JSON extraction: find the first '{' and last '}'
      const startIndex = raw.indexOf('{');
      const endIndex = raw.lastIndexOf('}');

      let jsonStr = raw;
      if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
        jsonStr = raw.substring(startIndex, endIndex + 1);
      }

      let data: {
        intent?: string;
        confidence?: number;
        entities?: IntentEntities;
        transcription?: string;
      } = {};

      try {
        data = JSON.parse(jsonStr);
      } catch (e) {
        this.logger.warn(
          `Could not parse Gemini JSON: ${(e as Error).message}`,
        );
        this.logger.warn(`RAW ORIGINAL STRING: >>>${raw}<<<`);
        this.logger.warn(`EXTRACTED JSON: >>>${jsonStr}<<<`);

        // Fallback attempt: if it's an unterminated string but ends well, maybe it's just missing a brace
        if (!jsonStr.endsWith('}')) {
          try {
            data = JSON.parse(jsonStr + '}');
          } catch {
            /* ignore */
          }
        }

        if (!Object.keys(data).length) {
          return ConversationIntentVO.unknown(fallbackRawText);
        }
      }

      const intent = (data.intent ?? 'unknown') as IntentType;
      const confidence = Math.min(1, Math.max(0, data.confidence ?? 0));
      let rawText = data.transcription ?? fallbackRawText;
      if (!rawText || rawText.trim() === '') rawText = '(sin texto)';

      // Validate intent is one of the allowed values
      const validIntents: IntentType[] = [
        'swap_shift',
        'report_absence',
        'check_schedule',
        'request_day_off',
        'generate_schedule',
        'select_option',
        'unknown',
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

      return ConversationIntentVO.create({
        intent,
        confidence,
        entities,
        rawText,
      });
    } catch (err) {
      this.logger.warn(
        `[_parseResponse] Could not parse Gemini JSON: ${(err as Error).message}`,
      );
      return ConversationIntentVO.unknown(fallbackRawText);
    }
  }
}
