import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai'; // Assuming this is how we imported it previously based on structure
import { ConflictResolutionEngine } from '../../domain/services/conflict-resolution.engine';

export interface MedicalCertificateData {
  patient_name: string;
  issue_date: string;
  rest_days: number;
  doctor_name: string;
  hospital_name: string;
}

@Injectable()
export class LlmParsingService {
  private readonly logger = new Logger(LlmParsingService.name);
  // Assuming a configured Gemini instance via typical factory/provider approach
  private readonly gemini: GoogleGenAI;

  constructor() {
    this.gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async parseMedicalCertificate(
    rawText: string,
  ): Promise<MedicalCertificateData> {
    this.logger.log('Parsing raw OCR text into JSON via Gemini 1.5 Pro');

    const prompt = `
      Extract structured data from this medical certificate.
      
      Fields required:
      - patient_name
      - issue_date (YYYY-MM-DD format)
      - rest_days (integer)
      - doctor_name
      - hospital_name

      Return JSON only without Markdown backticks. If any field is missing, return null for that field.
      
      Certificate Text:
      "${rawText}"
    `;

    try {
      const response = await this.gemini.models.generateContent({
        model: 'gemini-1.5-pro',
        contents: prompt,
      });

      const responseText = response.text || '{}';
      const cleanJsonStr = responseText
        .replace(/```json/g, '')
        .replace(/```/g, '')
        .trim();

      return JSON.parse(cleanJsonStr) as MedicalCertificateData;
    } catch (error) {
      this.logger.error('Failed to parse OCR text via Gemini LLM', error);
      throw error;
    }
  }
}
