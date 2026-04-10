import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IConversationalService } from '../../domain/services/conversational.service.interface';
import {
  ConversationIntentVO,
  IntentEntities,
  IntentType,
} from '../../domain/value-objects/conversation-intent.vo';

/**
 * QwenConversationalService — Adapter for IConversationalService
 *
 * Encargado de leer textos y audios a través de DashScope usando 
 * qwen-plus para texto, y qwen-audio-turbo (si está disponible) para audio.
 */
@Injectable()
export class QwenConversationalService implements IConversationalService {
  private readonly logger = new Logger(QwenConversationalService.name);
  private readonly apiKey: string;
  private readonly baseUrl =
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';

  private static readonly TEXT_MODEL = 'qwen-plus';
  private static readonly AUDIO_MODEL = 'qwen-audio-turbo-latest';
  private static readonly TIMEOUT_MS = 30_000;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.getOrThrow<string>('qwen.apiKey');
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  async processText(text: string): Promise<ConversationIntentVO> {
    const prompt = this.buildTextPrompt(text);
    try {
      const messages = [{ role: 'user', content: prompt }];
      const raw = await this._callQwen(
        QwenConversationalService.TEXT_MODEL,
        messages,
        QwenConversationalService.TIMEOUT_MS,
      );
      return this._parseResponse(raw, text);
    } catch (err) {
      const errMsg = (err as Error).message;
      this.logger.error(`[processText] Qwen call failed: ${errMsg}`);
      if (errMsg.includes('429')) {
         return ConversationIntentVO.systemUnavailable(text);
      }
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
    let format = mimeType.split('/')[1] || 'mp3';
    if (format === 'mpeg') format = 'mp3';
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

    // 2. Send audio via DashScope
    const prompt = this.buildAudioPrompt();
    try {
      // Usar compatible mode standard content elements
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'input_audio',
              input_audio: { data: audioBase64, format: format },
            },
          ],
        },
      ];
      
      const raw = await this._callQwen(
        QwenConversationalService.AUDIO_MODEL,
        messages as any,
        QwenConversationalService.TIMEOUT_MS * 2, // Más delay generoso
      );
      return this._parseResponse(raw, '(audio no transcrito)');
    } catch (err) {
      const errMsg = (err as Error).message;
      this.logger.error(`[processAudio] Qwen call failed: ${errMsg}`);
      // Fallback intent si la API falla de audio
      if (errMsg.includes('429')) {
         return ConversationIntentVO.systemUnavailable('(audio no transcrito)');
      }
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
- create_rule: el manager dicta una regla de negocio o restricción para la configuración de horarios (ej. "agrega una regla", "apunta esto", "los viernes ocupo 2 meseros", "se prohibe...", "por un mes...")
- unknown: la intención no es clara o no corresponde a ninguna de las anteriores

ENTIDADES A EXTRAER (pon null si no se menciona):
- date: fecha del turno en formato YYYY-MM-DD si se menciona
- targetEmployeePhone: número de teléfono del compañero con prefijo + si se menciona
- shiftId: ID del turno si se menciona explícitamente
- reason: motivo de la ausencia o solicitud (texto libre)
- weekStart: primer día de la semana (lunes) en formato YYYY-MM-DD si el usuario pregunta por una semana en particular
- timeOfDay: momento del día (ej. "morning", "afternoon", "night") si se menciona para la ausencia
- selection: opción seleccionada (ej. "1", "2", "yes", "no") si la intención es select_option
- ruleText: texto de la regla que el manager quiere añadir, limpio de saludos, en español. (si intent es create_rule)
- expiresAt: fecha exacta en la que la regla o evento expira y deja de tener efecto (en formato YYYY-MM-DD). Si el humano menciona un plazo, calcula la fecha final partiendo de HOY ${today}. Si es permanente, pon null.
- detectedLanguage: el código de idioma ISO 639-1 del mensaje (ej. "es", "en", "pt")

Responde ÚNICAMENTE con JSON válido, sin texto adicional (nada de marcas markdown):
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
    "selection": <string|null>,
    "ruleText": <string|null>,
    "expiresAt": <string|null>,
    "detectedLanguage": <string|null>
  },
  "transcription": null
}

Mensaje del empleado: "${text.replace(/"/g, '\\"')}"`;
  }

  private buildAudioPrompt(): string {
    const today = new Date().toISOString().split('T')[0];
    return `Eres un clasificador de intenciones para un sistema de gestión de turnos de trabajo.
Hoy es ${today}.
Recibirás un audio de un empleado o manager. 

Primero transcribe el audio fielmente (en su idioma original). Luego clasifica la intención y extrae entidades.

INTENCIONES DISPONIBLES:
- swap_shift: el empleado quiere intercambiar su turno con otro
- report_absence: el empleado no puede asistir a su turno
- check_schedule: el empleado quiere ver su horario
- request_day_off: el empleado solicita un día libre
- generate_schedule: el manager quiere generar el horario de la semana (frases como "genera el horario", "crea los turnos", "planifica la semana que viene")
- select_option: el usuario está seleccionando una opción de una lista (ej. "el número 1", "opción 2") o respondiendo (ej. "sí", "no")
- create_rule: el manager dicta una regla de negocio o restricción para la configuración de horarios (ej. "agrega una regla", "apunta esto", "los viernes ocupo 2 meseros", "se prohibe...", "por un mes...")
- unknown: la intención no es clara o no corresponde a ninguna de las anteriores

ENTIDADES A EXTRAER (pon null si no se menciona):
- date: fecha del turno en formato YYYY-MM-DD si se menciona
- targetEmployeePhone: número de teléfono del compañero con prefijo + si se menciona
- shiftId: ID del turno si se menciona explícitamente
- reason: motivo de la ausencia o solicitud (texto libre)
- weekStart: primer día de la semana (lunes) en formato YYYY-MM-DD si el usuario pregunta por una semana en particular
- timeOfDay: momento del día (ej. "morning", "afternoon", "night") si se menciona para la ausencia
- selection: opción seleccionada (ej. "1", "2", "yes", "no") si la intención es select_option
- ruleText: texto de la regla que el manager quiere añadir, limpio de saludos, en español. (si intent es create_rule)
- expiresAt: fecha exacta en la que la regla o evento expira y deja de tener efecto (en formato YYYY-MM-DD). Si el humano menciona un plazo, calcula la fecha final partiendo de HOY ${today}. Si es permanente, pon null.
- detectedLanguage: el código de idioma ISO 639-1 del mensaje (ej. "es", "en", "pt")

Responde ÚNICAMENTE con JSON válido puro, sin texto adicional (nada de marcas markdown):
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
    "selection": <string|null>,
    "ruleText": <string|null>,
    "expiresAt": <string|null>,
    "detectedLanguage": <string|null>
  },
  "transcription": "<transcripcion textual exacta del audio>"
}`;
  }

  // ─── HTTP helper ──────────────────────────────────────────────────────────

  private async _callQwen(
    model: string,
    messages: any[],
    timeoutMs: number,
  ): Promise<string> {
    const maxRetries = 3;
    const baseDelayMs = 1000;

    const bodyStr = JSON.stringify({
      model: model,
      messages: messages,
      temperature: 0.1,
      max_tokens: 4096,
      response_format: { type: "json_object" } // Qwen2.5+ soporta json_object en dashscope
    });

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetch(this.baseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: bodyStr,
          signal: controller.signal,
        });
      } catch (err: any) {
        clearTimeout(timer);
        if (attempt === maxRetries) throw new Error(`Qwen fetch error: ${err.message}`);
        await this._delay(baseDelayMs * Math.pow(2, attempt - 1));
        continue;
      }
      clearTimeout(timer);

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 429) {
          if (attempt === maxRetries) {
            throw new Error(`(429) Qwen Timeout Exhausted: Rate Limit Exceeded`);
          }
          this.logger.warn(`Qwen 429 on attempt ${attempt}. Retrying...`);
          await this._delay(baseDelayMs * Math.pow(2, attempt - 1));
          continue;
        }
        throw new Error(`Qwen API error ${response.status}: ${errorText}`);
      }

      const json = (await response.json()) as any;
      const text = json?.choices?.[0]?.message?.content;
      
      const usage = json?.usage;
      if (usage) {
        this.logger.log(
          `🧠 Qwen Conversational Token Usage -> Prompt: ${usage.prompt_tokens} | Completion: ${usage.completion_tokens} | Total: ${usage.total_tokens}`,
        );
      }

      if (!text) throw new Error('Empty response from Qwen');
      return text;
    }
    throw new Error('Unreachable code');
  }

  private _delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
      // Extraemos el JSON
      const startIndex = raw.indexOf('{');
      const endIndex = raw.lastIndexOf('}');

      let jsonStr = raw;
      if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
        jsonStr = raw.substring(startIndex, endIndex + 1);
      }

      let data: any = {};
      try {
        data = JSON.parse(jsonStr);
      } catch (e) {
        this.logger.warn(
          `Could not parse Qwen JSON: ${(e as Error).message}`,
        );
        this.logger.warn(`RAW ORIGINAL STRING: >>>${raw}<<<`);

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

      // Validamos intención aceptada
      const validIntents: string[] = [
        'swap_shift', 'report_absence', 'check_schedule',
        'request_day_off', 'generate_schedule', 'select_option',
        'create_rule', 'system_unavailable', 'unknown',
      ];
      if (!validIntents.includes(intent)) {
        return ConversationIntentVO.unknown(rawText);
      }

      // Evitamos objetos null en entities
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
        `[_parseResponse] Error: ${(err as Error).message}`,
      );
      return ConversationIntentVO.unknown(fallbackRawText);
    }
  }
}
