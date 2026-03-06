import { ConversationIntentVO } from '../value-objects/conversation-intent.vo';

/**
 * Port: IConversationalService
 *
 * Defines the contract for processing WhatsApp messages (text and audio)
 * and returning a classified intent with extracted entities.
 *
 * The domain doesn't know whether the implementation uses Gemini, GPT,
 * or any other provider — it only knows this interface.
 */
export interface IConversationalService {
    /**
     * Classifies the intent and extracts entities from a plain text message.
     */
    processText(text: string): Promise<ConversationIntentVO>;

    /**
     * Downloads the audio from `audioUrl` (authenticated with Twilio credentials),
     * sends it inline to the LLM, and returns the classified intent.
     *
     * @param audioUrl    - Twilio media URL (requires Basic Auth)
     * @param mimeType    - MIME type of the audio (e.g., 'audio/ogg; codecs=opus')
     * @param twilioSid   - Twilio Account SID (for Basic Auth download)
     * @param twilioToken - Twilio Auth Token (for Basic Auth download)
     */
    processAudio(
        audioUrl: string,
        mimeType: string,
        twilioSid: string,
        twilioToken: string,
    ): Promise<ConversationIntentVO>;
}

export const CONVERSATIONAL_SERVICE = 'CONVERSATIONAL_SERVICE';
