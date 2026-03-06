import { IsOptional, IsString, IsUrl } from 'class-validator';

/**
 * WhatsappWebhookDto
 *
 * Maps the raw Twilio webhook body (form-encoded) to typed properties.
 * Twilio sends: From, Body, NumMedia, MediaUrl0, MediaContentType0, etc.
 */
export class WhatsappWebhookDto {
    /** Sender's WhatsApp number in E.164 format, prefixed with "whatsapp:" */
    @IsString()
    From!: string;

    /** Text body — present for text messages, empty for audio/media */
    @IsOptional()
    @IsString()
    Body?: string;

    /** Number of media attachments (0 = text only) */
    @IsOptional()
    @IsString()
    NumMedia?: string;

    /** Media URL for the first attachment (audio, image, etc.) */
    @IsOptional()
    @IsUrl({}, { message: 'MediaUrl0 must be a valid URL' })
    MediaUrl0?: string;

    /** MIME type of the first media attachment */
    @IsOptional()
    @IsString()
    MediaContentType0?: string;
}
