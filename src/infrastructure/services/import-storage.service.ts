import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';

/**
 * ImportStorageService — wrapper sobre Supabase Storage para el bucket
 * privado `import-uploads` (creado en migration Fase 3).
 *
 * Layout de paths: `${companyId}/${importId}/original.${ext}` — el
 * tenant key vive en el primer segmento porque las RLS policies del
 * bucket lo usan para enforzar aislamiento.
 *
 * Backend usa service role para upload/download/delete — el flow no
 * involucra al cliente directamente (multipart al endpoint backend).
 * No emitimos signed URLs porque el cliente no necesita acceso directo:
 * la preview se sirve desde imports_staging.payload.
 */
@Injectable()
export class ImportStorageService {
  private readonly logger = new Logger(ImportStorageService.name);
  private readonly bucket = 'import-uploads';

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  buildPath(companyId: string, importId: string, mimeType: string): string {
    const ext = this.extFromMime(mimeType);
    return `${companyId}/${importId}/original.${ext}`;
  }

  async upload(
    path: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<void> {
    const { error } = await this.supabase.storage
      .from(this.bucket)
      .upload(path, buffer, {
        contentType,
        upsert: true,
      });
    if (error) {
      throw new Error(
        `ImportStorageService.upload(${path}) failed: ${error.message}`,
      );
    }
  }

  async download(path: string): Promise<Buffer> {
    const { data, error } = await this.supabase.storage
      .from(this.bucket)
      .download(path);
    if (error || !data) {
      throw new Error(
        `ImportStorageService.download(${path}) failed: ${error?.message ?? 'no data'}`,
      );
    }
    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async delete(path: string): Promise<void> {
    const { error } = await this.supabase.storage
      .from(this.bucket)
      .remove([path]);
    if (error) {
      // No rethrow — borrar es best-effort, el row de staging es la
      // fuente de verdad y el cleanup job lo barre.
      this.logger.warn(
        `ImportStorageService.delete(${path}) failed: ${error.message}`,
      );
    }
  }

  private extFromMime(mimeType: string): string {
    switch (mimeType) {
      case 'application/pdf':
        return 'pdf';
      case 'image/png':
        return 'png';
      case 'image/jpeg':
      case 'image/jpg':
        return 'jpg';
      case 'image/webp':
        return 'webp';
      default:
        return 'bin';
    }
  }
}
