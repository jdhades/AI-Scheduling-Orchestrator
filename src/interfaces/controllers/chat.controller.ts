import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { SupabaseClient } from '@supabase/supabase-js';

import { CurrentCompany } from '../../infrastructure/auth/decorators/current-company.decorator';
import { CurrentUser } from '../../infrastructure/auth/decorators/current-user.decorator';
import { Requires } from '../../infrastructure/auth/decorators/requires.decorator';
import type { AuthContext } from '../../infrastructure/auth/auth-context';
import { NotificationsGateway } from '../../infrastructure/websocket/notifications.gateway';
import { PushService } from '../../infrastructure/notifications/push.service';

export class SendMessageDto {
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  content?: string;

  @IsOptional()
  @IsString()
  clientUuid?: string;

  /** Path en el bucket `chat-attachments` (la app sube el archivo y manda el path). */
  @IsOptional()
  @IsString()
  attachmentPath?: string;

  @IsOptional()
  @IsIn(['image', 'file'])
  attachmentType?: 'image' | 'file';

  @IsOptional()
  @IsString()
  @MaxLength(255)
  attachmentName?: string;
}

export class CreateRoomDto {
  @IsIn(['dm', 'group'])
  type!: 'dm' | 'group';

  /** dm: el otro empleado. */
  @IsOptional()
  @IsString()
  memberId?: string;

  /** group: nombre + miembros. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  memberIds?: string[];
}

export class AddMembersDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  memberIds!: string[];
}

export class BroadcastDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  content!: string;
}

interface MessageDTO {
  id: string;
  roomId: string;
  senderId: string | null;
  senderName: string | null;
  content: string;
  createdAt: string;
  attachmentUrl: string | null;
  attachmentType: 'image' | 'file' | null;
  attachmentName: string | null;
}

const MSG_COLS =
  'id, room_id, sender_id, content, created_at, attachment_path, attachment_type, attachment_name';

interface RoomDTO {
  id: string;
  type: 'dm' | 'group';
  title: string;
  memberCount: number;
  lastMessage: { content: string; createdAt: string; senderName: string | null } | null;
  unreadCount: number;
  updatedAt: string;
}

/**
 * ChatController — tenant business chat (Sprint 3). 1:1 (dm) + group rooms.
 * Tenant + actor come from the JWT. Membership is enforced per room.
 *   GET  /chat/rooms                  → my rooms (last message + unread)
 *   POST /chat/rooms                  → create group / ensure dm
 *   GET  /chat/rooms/:id/messages     → paginated history
 *   POST /chat/rooms/:id/messages     → send (idempotent by clientUuid)
 *   POST /chat/rooms/:id/read         → mark read (clears unread)
 */
@Controller('chat')
export class ChatController {
  constructor(
    @Inject('SUPABASE_CLIENT') private readonly supabase: SupabaseClient,
    private readonly notifications: NotificationsGateway,
    private readonly push: PushService,
  ) {}

  private meId(user: AuthContext | undefined): string {
    if (!user?.employeeId) {
      throw new NotFoundException('No employee is linked to this account');
    }
    return user.employeeId;
  }

  private async ensureMember(roomId: string, employeeId: string, companyId: string): Promise<void> {
    const { data } = await this.supabase
      .from('chat_room_members')
      .select('room_id')
      .eq('room_id', roomId)
      .eq('employee_id', employeeId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (!data) throw new ForbiddenException('You are not a member of this room');
  }

  /**
   * GET /chat/contacts — empleados del tenant (para iniciar un chat). Cualquier
   * empleado puede ver a sus compañeros para abrir un DM / armar un grupo.
   */
  @Get('contacts')
  async contacts(
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<{ id: string; name: string }[]> {
    const me = this.meId(user);
    const { data } = await this.supabase
      .from('employees')
      .select('id, name')
      .eq('company_id', companyId)
      .neq('id', me)
      .order('name', { ascending: true });
    return (data ?? []).map((e) => ({ id: e.id as string, name: e.name as string }));
  }

  // ── Rooms ───────────────────────────────────────────────────────────
  @Get('rooms')
  async myRooms(
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<RoomDTO[]> {
    const me = this.meId(user);
    const { data: myMems } = await this.supabase
      .from('chat_room_members')
      .select('room_id, last_read_at')
      .eq('employee_id', me)
      .eq('company_id', companyId);
    const roomIds = (myMems ?? []).map((m) => m.room_id as string);
    if (roomIds.length === 0) return [];
    const lastReadByRoom = new Map(
      (myMems ?? []).map((m) => [m.room_id as string, (m.last_read_at as string) ?? null]),
    );

    const [{ data: rooms }, { data: allMems }] = await Promise.all([
      this.supabase
        .from('chat_rooms')
        .select('id, type, name, updated_at')
        .in('id', roomIds),
      this.supabase
        .from('chat_room_members')
        .select('room_id, employee_id')
        .in('room_id', roomIds),
    ]);
    const memberIds = [...new Set((allMems ?? []).map((m) => m.employee_id as string))];
    const { data: emps } = await this.supabase
      .from('employees')
      .select('id, name')
      .in('id', memberIds);
    const empName = new Map((emps ?? []).map((e) => [e.id as string, e.name as string]));
    const membersByRoom = new Map<string, string[]>();
    for (const m of allMems ?? []) {
      const arr = membersByRoom.get(m.room_id as string) ?? [];
      arr.push(m.employee_id as string);
      membersByRoom.set(m.room_id as string, arr);
    }

    const enriched = await Promise.all(
      (rooms ?? []).map(async (r) => {
        const roomId = r.id as string;
        const { data: lastArr } = await this.supabase
          .from('chat_messages')
          .select('content, created_at, sender_id')
          .eq('room_id', roomId)
          .order('created_at', { ascending: false })
          .limit(1);
        const last = lastArr?.[0] ?? null;

        const lastRead = lastReadByRoom.get(roomId);
        let unreadQ = this.supabase
          .from('chat_messages')
          .select('id', { count: 'exact', head: true })
          .eq('room_id', roomId)
          .neq('sender_id', me);
        if (lastRead) unreadQ = unreadQ.gt('created_at', lastRead);
        const { count } = await unreadQ;

        const members = membersByRoom.get(roomId) ?? [];
        const others = members.filter((id) => id !== me);
        const title =
          (r.type as string) === 'group'
            ? ((r.name as string) ?? 'Group')
            : (empName.get(others[0]) ?? 'Direct message');

        return {
          id: roomId,
          type: r.type as 'dm' | 'group',
          title,
          memberCount: members.length,
          lastMessage: last
            ? {
                content: last.content as string,
                createdAt: last.created_at as string,
                senderName: empName.get(last.sender_id as string) ?? null,
              }
            : null,
          unreadCount: count ?? 0,
          updatedAt: (last?.created_at as string) ?? (r.updated_at as string),
        };
      }),
    );
    return enriched.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  @Post('rooms')
  @HttpCode(HttpStatus.CREATED)
  async createRoom(
    @Body() dto: CreateRoomDto,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<{ id: string }> {
    const me = this.meId(user);

    if (dto.type === 'dm') {
      if (!dto.memberId) throw new BadRequestException('memberId is required for a dm');
      if (dto.memberId === me) throw new BadRequestException('Cannot start a dm with yourself');
      await this.assertEmployees(companyId, [dto.memberId]);
      const existing = await this.findDm(companyId, me, dto.memberId);
      if (existing) return { id: existing };
      const roomId = await this.insertRoom(companyId, 'dm', null, me);
      await this.addMembers(roomId, companyId, [
        { employeeId: me, role: 'member' },
        { employeeId: dto.memberId, role: 'member' },
      ]);
      return { id: roomId };
    }

    // group
    if (!dto.name?.trim()) throw new BadRequestException('name is required for a group');
    const others = [...new Set(dto.memberIds ?? [])].filter((id) => id !== me);
    await this.assertEmployees(companyId, others);
    const roomId = await this.insertRoom(companyId, 'group', dto.name.trim(), me);
    await this.addMembers(roomId, companyId, [
      { employeeId: me, role: 'admin' },
      ...others.map((employeeId) => ({ employeeId, role: 'member' as const })),
    ]);
    return { id: roomId };
  }

  // ── Messages ────────────────────────────────────────────────────────
  @Get('rooms/:id/messages')
  async history(
    @Param('id') roomId: string,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ): Promise<MessageDTO[]> {
    const me = this.meId(user);
    await this.ensureMember(roomId, me, companyId);
    const take = Math.min(Math.max(Number(limit) || 50, 1), 100);
    let q = this.supabase
      .from('chat_messages')
      .select(MSG_COLS)
      .eq('room_id', roomId)
      .order('created_at', { ascending: false })
      .limit(take);
    if (before) q = q.lt('created_at', before);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    const senderIds = [...new Set(rows.map((r) => r.sender_id as string).filter(Boolean))];
    const { data: emps } = senderIds.length
      ? await this.supabase.from('employees').select('id, name').in('id', senderIds)
      : { data: [] as { id: string; name: string }[] };
    const empName = new Map((emps ?? []).map((e) => [e.id as string, e.name as string]));
    // Devolvemos ascendente (viejo → nuevo) para render directo.
    return Promise.all(
      rows
        .slice()
        .reverse()
        .map(async (r) => ({
          id: r.id as string,
          roomId: r.room_id as string,
          senderId: (r.sender_id as string) ?? null,
          senderName: r.sender_id ? (empName.get(r.sender_id as string) ?? null) : null,
          content: r.content as string,
          createdAt: r.created_at as string,
          attachmentUrl: await this.signAttachment((r.attachment_path as string) ?? null),
          attachmentType: ((r.attachment_type as string) ?? null) as 'image' | 'file' | null,
          attachmentName: (r.attachment_name as string) ?? null,
        })),
    );
  }

  @Post('rooms/:id/messages')
  @HttpCode(HttpStatus.CREATED)
  async send(
    @Param('id') roomId: string,
    @Body() dto: SendMessageDto,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<MessageDTO> {
    const me = this.meId(user);
    await this.ensureMember(roomId, me, companyId);

    const content = (dto.content ?? '').trim();
    if (!content && !dto.attachmentPath) {
      throw new BadRequestException('content or attachment is required');
    }

    const { data: inserted, error } = await this.supabase
      .from('chat_messages')
      .insert({
        company_id: companyId,
        room_id: roomId,
        sender_id: me,
        content,
        client_uuid: dto.clientUuid ?? null,
        attachment_path: dto.attachmentPath ?? null,
        attachment_type: dto.attachmentType ?? null,
        attachment_name: dto.attachmentName ?? null,
      })
      .select(MSG_COLS)
      .single();
    if (error) {
      // Idempotencia: retry offline con el mismo client_uuid → devolver el original.
      if ((error as { code?: string }).code === '23505' && dto.clientUuid) {
        const { data: raced } = await this.supabase
          .from('chat_messages')
          .select(MSG_COLS)
          .eq('room_id', roomId)
          .eq('client_uuid', dto.clientUuid)
          .maybeSingle();
        if (raced) return this.withSender(raced, me, user);
      }
      throw new Error(error.message);
    }

    // touch room.updated_at para ordenar la lista por actividad.
    await this.supabase
      .from('chat_rooms')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', roomId);

    const dtoOut = await this.withSender(inserted, me, user);
    // Realtime: avisar a la company (los clientes filtran por room).
    this.notifications.notifyChatMessage(companyId, roomId, dtoOut);
    // Push a los demás miembros (best-effort, no bloquea la respuesta).
    void this.supabase
      .from('chat_room_members')
      .select('employee_id')
      .eq('room_id', roomId)
      .neq('employee_id', me)
      .then(({ data }) =>
        this.push.sendToEmployees(
          companyId,
          (data ?? []).map((m) => m.employee_id as string),
          {
            title: dtoOut.senderName ?? 'Mensaje',
            body: content || '📷',
            data: { type: 'chat', roomId },
          },
        ),
      );
    return dtoOut;
  }

  @Post('rooms/:id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markRead(
    @Param('id') roomId: string,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    const me = this.meId(user);
    const { error } = await this.supabase
      .from('chat_room_members')
      .update({ last_read_at: new Date().toISOString() })
      .eq('room_id', roomId)
      .eq('employee_id', me)
      .eq('company_id', companyId);
    if (error) throw new Error(error.message);
  }

  // ── Group members ───────────────────────────────────────────────────
  @Get('rooms/:id/members')
  async members(
    @Param('id') roomId: string,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<{ id: string; name: string; role: string }[]> {
    const me = this.meId(user);
    await this.ensureMember(roomId, me, companyId);
    const { data: mems } = await this.supabase
      .from('chat_room_members')
      .select('employee_id, role')
      .eq('room_id', roomId)
      .eq('company_id', companyId);
    const ids = (mems ?? []).map((m) => m.employee_id as string);
    const { data: emps } = ids.length
      ? await this.supabase.from('employees').select('id, name').in('id', ids)
      : { data: [] as { id: string; name: string }[] };
    const name = new Map((emps ?? []).map((e) => [e.id as string, e.name as string]));
    return (mems ?? []).map((m) => ({
      id: m.employee_id as string,
      name: name.get(m.employee_id as string) ?? '',
      role: m.role as string,
    }));
  }

  @Post('rooms/:id/members')
  @HttpCode(HttpStatus.NO_CONTENT)
  async addRoomMembers(
    @Param('id') roomId: string,
    @Body() dto: AddMembersDto,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    const me = this.meId(user);
    await this.ensureMember(roomId, me, companyId);
    const { data: room } = await this.supabase
      .from('chat_rooms')
      .select('type')
      .eq('id', roomId)
      .eq('company_id', companyId)
      .maybeSingle();
    if (!room) throw new NotFoundException('Room not found');
    if (room.type !== 'group') throw new BadRequestException('Only group rooms have members');
    const ids = [...new Set(dto.memberIds)].filter(Boolean);
    await this.assertEmployees(companyId, ids);
    await this.addMembers(
      roomId,
      companyId,
      ids.map((employeeId) => ({ employeeId, role: 'member' as const })),
    );
  }

  @Delete('rooms/:id/members/:employeeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(
    @Param('id') roomId: string,
    @Param('employeeId') employeeId: string,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<void> {
    const me = this.meId(user);
    await this.ensureMember(roomId, me, companyId);
    // Self-leave siempre; sacar a otro requiere ser admin de la sala.
    if (employeeId !== me) {
      const { data: myMem } = await this.supabase
        .from('chat_room_members')
        .select('role')
        .eq('room_id', roomId)
        .eq('employee_id', me)
        .maybeSingle();
      if ((myMem?.role as string) !== 'admin') {
        throw new ForbiddenException('Only an admin can remove other members');
      }
    }
    const { error } = await this.supabase
      .from('chat_room_members')
      .delete()
      .eq('room_id', roomId)
      .eq('employee_id', employeeId)
      .eq('company_id', companyId);
    if (error) throw new Error(error.message);
  }

  // ── Broadcast ───────────────────────────────────────────────────────
  /**
   * POST /chat/broadcast — anuncio a toda la empresa. Asegura el grupo de
   * anuncios (uno por company, todos los empleados como miembros) y postea.
   * Solo owner/manager.
   */
  @Post('broadcast')
  @Requires('schedule:write')
  @HttpCode(HttpStatus.CREATED)
  async broadcast(
    @Body() dto: BroadcastDto,
    @CurrentUser() user: AuthContext | undefined,
    @CurrentCompany() companyId: string,
  ): Promise<{ roomId: string }> {
    const me = this.meId(user);
    const content = dto.content.trim();
    if (!content) throw new BadRequestException('content is required');

    let roomId = await this.findAnnouncementsRoom(companyId);
    if (!roomId) {
      const { data: company } = await this.supabase
        .from('companies')
        .select('name')
        .eq('id', companyId)
        .maybeSingle();
      const { data: room, error } = await this.supabase
        .from('chat_rooms')
        .insert({
          company_id: companyId,
          type: 'group',
          name: `📢 ${(company?.name as string) ?? 'Announcements'}`,
          created_by: me,
          is_announcement: true,
        })
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      roomId = room.id as string;
    }

    const { data: emps } = await this.supabase
      .from('employees')
      .select('id')
      .eq('company_id', companyId);
    await this.addMembers(
      roomId,
      companyId,
      (emps ?? []).map((e) => ({
        employeeId: e.id as string,
        role: ((e.id as string) === me ? 'admin' : 'member') as 'admin' | 'member',
      })),
    );

    const { data: inserted, error: msgErr } = await this.supabase
      .from('chat_messages')
      .insert({ company_id: companyId, room_id: roomId, sender_id: me, content })
      .select(MSG_COLS)
      .single();
    if (msgErr) throw new Error(msgErr.message);
    await this.supabase
      .from('chat_rooms')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', roomId);
    const dtoOut = await this.withSender(inserted, me, user);
    this.notifications.notifyChatMessage(companyId, roomId, dtoOut);
    return { roomId };
  }

  // ── helpers ─────────────────────────────────────────────────────────
  private async findAnnouncementsRoom(companyId: string): Promise<string | null> {
    const { data } = await this.supabase
      .from('chat_rooms')
      .select('id')
      .eq('company_id', companyId)
      .eq('is_announcement', true)
      .maybeSingle();
    return (data?.id as string) ?? null;
  }

  private async withSender(
    row: Record<string, unknown>,
    me: string,
    user: AuthContext | undefined,
  ): Promise<MessageDTO> {
    const senderId = (row.sender_id as string) ?? null;
    let senderName: string | null = null;
    if (senderId === me) {
      senderName = null; // el cliente sabe que es propio; opcional resolver nombre
    }
    if (senderId && senderName === null) {
      const { data: emp } = await this.supabase
        .from('employees')
        .select('name')
        .eq('id', senderId)
        .maybeSingle();
      senderName = (emp?.name as string) ?? null;
    }
    void user;
    return {
      id: row.id as string,
      roomId: row.room_id as string,
      senderId,
      senderName,
      content: row.content as string,
      createdAt: row.created_at as string,
      attachmentUrl: await this.signAttachment((row.attachment_path as string) ?? null),
      attachmentType: ((row.attachment_type as string) ?? null) as 'image' | 'file' | null,
      attachmentName: (row.attachment_name as string) ?? null,
    };
  }

  /** URL firmada (1h) del adjunto, o null. Bucket privado `chat-attachments`. */
  private async signAttachment(path: string | null): Promise<string | null> {
    if (!path) return null;
    const { data } = await this.supabase.storage
      .from('chat-attachments')
      .createSignedUrl(path, 3600);
    return data?.signedUrl ?? null;
  }

  private async assertEmployees(companyId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { data } = await this.supabase
      .from('employees')
      .select('id')
      .eq('company_id', companyId)
      .in('id', ids);
    const valid = new Set((data ?? []).map((e) => e.id as string));
    const bad = ids.filter((i) => !valid.has(i));
    if (bad.length) throw new BadRequestException(`Unknown employee(s): ${bad.join(', ')}`);
  }

  private async findDm(companyId: string, me: string, other: string): Promise<string | null> {
    const { data: myMems } = await this.supabase
      .from('chat_room_members')
      .select('room_id')
      .eq('employee_id', me)
      .eq('company_id', companyId);
    const myRoomIds = (myMems ?? []).map((m) => m.room_id as string);
    if (myRoomIds.length === 0) return null;
    const { data: dmRooms } = await this.supabase
      .from('chat_rooms')
      .select('id')
      .eq('type', 'dm')
      .in('id', myRoomIds);
    const dmIds = (dmRooms ?? []).map((r) => r.id as string);
    if (dmIds.length === 0) return null;
    const { data: both } = await this.supabase
      .from('chat_room_members')
      .select('room_id')
      .eq('employee_id', other)
      .in('room_id', dmIds);
    return (both?.[0]?.room_id as string) ?? null;
  }

  private async insertRoom(
    companyId: string,
    type: 'dm' | 'group',
    name: string | null,
    createdBy: string,
  ): Promise<string> {
    const { data, error } = await this.supabase
      .from('chat_rooms')
      .insert({ company_id: companyId, type, name, created_by: createdBy })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  }

  private async addMembers(
    roomId: string,
    companyId: string,
    members: { employeeId: string; role: 'member' | 'admin' }[],
  ): Promise<void> {
    const rows = members.map((m) => ({
      room_id: roomId,
      company_id: companyId,
      employee_id: m.employeeId,
      role: m.role,
    }));
    const { error } = await this.supabase
      .from('chat_room_members')
      .upsert(rows, { onConflict: 'room_id,employee_id', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  }
}
