import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { IImportStagingRepository } from '../../domain/imports/import-staging.repository';
import { ImportStaging } from '../../domain/imports/import-staging.aggregate';
import type {
  ImportPayload,
  ImportSource,
  ImportStagingStatus,
} from '../../domain/imports/import-payload.types';

interface Row {
  id: string;
  company_id: string;
  created_by: string | null;
  source: ImportSource;
  payload: ImportPayload;
  status: ImportStagingStatus;
  preview_cache: unknown | null;
  commit_report: unknown | null;
  created_at: string;
  expires_at: string;
  committed_at: string | null;
  upload_storage_path: string | null;
  upload_mime_type: string | null;
  extract_raw_output: unknown | null;
  pre_commit_snapshot: unknown | null;
  reverted_at: string | null;
}

@Injectable()
export class SupabaseImportStagingRepository implements IImportStagingRepository {
  private readonly logger = new Logger(SupabaseImportStagingRepository.name);

  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
  ) {}

  async save(staging: ImportStaging): Promise<void> {
    const { error } = await this.supabase.from('imports_staging').upsert({
      id: staging.id,
      company_id: staging.companyId,
      created_by: staging.createdBy,
      source: staging.source,
      payload: staging.payload,
      status: staging.status,
      preview_cache: staging.previewCache,
      commit_report: staging.commitReport,
      created_at: staging.createdAt.toISOString(),
      expires_at: staging.expiresAt.toISOString(),
      committed_at: staging.committedAt?.toISOString() ?? null,
      upload_storage_path: staging.uploadStoragePath,
      upload_mime_type: staging.uploadMimeType,
      extract_raw_output: staging.extractRawOutput,
      pre_commit_snapshot: staging.preCommitSnapshot,
      reverted_at: staging.revertedAt?.toISOString() ?? null,
    });
    if (error) {
      throw new Error(`ImportStagingRepository.save failed: ${error.message}`);
    }
  }

  async findById(id: string, companyId: string): Promise<ImportStaging | null> {
    const { data, error } = await this.supabase
      .from('imports_staging')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle();
    if (error) {
      throw new Error(
        `ImportStagingRepository.findById failed: ${error.message}`,
      );
    }
    if (!data) return null;
    return this.mapRow(data as Row);
  }

  async findByIdCrossTenant(id: string): Promise<ImportStaging | null> {
    const { data, error } = await this.supabase
      .from('imports_staging')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) {
      throw new Error(
        `ImportStagingRepository.findByIdCrossTenant failed: ${error.message}`,
      );
    }
    if (!data) return null;
    return this.mapRow(data as Row);
  }

  async listByCompany(
    companyId: string,
    opts?: { status?: ImportStagingStatus[]; limit?: number },
  ): Promise<ImportStaging[]> {
    let q = this.supabase
      .from('imports_staging')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });
    if (opts?.status && opts.status.length > 0) {
      q = q.in('status', opts.status);
    }
    if (opts?.limit) {
      q = q.limit(opts.limit);
    }
    const { data, error } = await q;
    if (error) {
      throw new Error(`ImportStagingRepository.list failed: ${error.message}`);
    }
    return ((data ?? []) as Row[]).map((r) => this.mapRow(r));
  }

  async deleteExpired(): Promise<number> {
    const { data, error } = await this.supabase
      .from('imports_staging')
      .delete()
      .eq('status', 'pending_review')
      .lt('expires_at', new Date().toISOString())
      .select('id');
    if (error) {
      this.logger.warn(`deleteExpired failed: ${error.message}`);
      return 0;
    }
    return (data ?? []).length;
  }

  private mapRow(r: Row): ImportStaging {
    return ImportStaging.fromPersistence({
      id: r.id,
      companyId: r.company_id,
      createdBy: r.created_by,
      source: r.source,
      payload: r.payload,
      status: r.status,
      previewCache: r.preview_cache,
      commitReport: r.commit_report,
      createdAt: new Date(r.created_at),
      expiresAt: new Date(r.expires_at),
      committedAt: r.committed_at ? new Date(r.committed_at) : null,
      uploadStoragePath: r.upload_storage_path,
      uploadMimeType: r.upload_mime_type,
      extractRawOutput: r.extract_raw_output,
      preCommitSnapshot: r.pre_commit_snapshot,
      revertedAt: r.reverted_at ? new Date(r.reverted_at) : null,
    });
  }
}
