import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { IHandshakeRepository } from '../../domain/repositories/handshake.repository';
import { WhatsappHandshake } from '../../domain/aggregates/whatsapp-handshake.aggregate';

/**
 * SupabaseHandshakeRepository — Adapter (DDD)
 *
 * Persiste los datos del handshake (token, expiración, estado)
 * en la tabla whatsapp_handshakes.
 */
@Injectable()
export class SupabaseHandshakeRepository implements IHandshakeRepository {
    constructor(
        @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    ) { }

    async save(
        handshake: WhatsappHandshake,
        tokenValue: string,
        expiresAt: Date,
    ): Promise<void> {
        const { error } = await this.supabase
            .from('whatsapp_handshakes')
            .insert({
                id: handshake.id,
                employee_id: handshake.employeeId,
                token: tokenValue,
                expires_at: expiresAt.toISOString(),
                verified: false,
            });

        if (error) throw new Error(`HandshakeRepository.save failed: ${error.message}`);
    }

    async findById(id: string): Promise<{
        employeeId: string;
        phone: string;
        token: string;
        expiresAt: Date;
        verified: boolean;
    } | null> {
        const { data, error } = await this.supabase
            .from('whatsapp_handshakes')
            .select('*, employees(phone_number)')
            .eq('id', id)
            .single();

        if (error || !data) return null;

        return {
            employeeId: data.employee_id,
            phone: data.employees?.phone_number ?? '',
            token: data.token,
            expiresAt: new Date(data.expires_at),
            verified: data.verified,
        };
    }

    async markVerified(handshakeId: string): Promise<void> {
        const { error } = await this.supabase
            .from('whatsapp_handshakes')
            .update({ verified: true })
            .eq('id', handshakeId);

        if (error) throw new Error(`HandshakeRepository.markVerified failed: ${error.message}`);
    }
}
