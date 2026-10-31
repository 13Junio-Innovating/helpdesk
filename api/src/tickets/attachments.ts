import { Body, Controller, Delete, Get, HttpCode, Injectable, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES as SHARED_MAX, type TicketAttachment } from '@helpdesk/shared';
import type { TenantUser } from '../common/auth/auth-user.js';
import { CurrentTenantUser, tenantCtx } from '../common/auth/decorators.js';
import { DbService, type Tx } from '../common/db/db.service.js';
import { AppException } from '../common/errors/app-exception.js';
import { StorageService } from '../storage/storage.service.js';

// mesmo limite do CHECK em attachments.size_bytes; lista fechada: nada de HTML/SVG/executáveis
export const MAX_ATTACHMENT_BYTES = SHARED_MAX;
export const ALLOWED_TYPES = ATTACHMENT_TYPES;

class PresignDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(255) filename: string;
  @ApiProperty({ enum: ALLOWED_TYPES }) @IsIn(ALLOWED_TYPES, { message: 'tipo de arquivo não permitido' }) contentType: string;
  @ApiProperty({ maximum: MAX_ATTACHMENT_BYTES }) @IsInt() @Min(1) @Max(MAX_ATTACHMENT_BYTES, { message: 'arquivo maior que 25 MB' }) size: number;
}

class ConfirmDto extends PresignDto {
  @ApiProperty() @IsString() @MaxLength(400) storageKey: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID('all') messageId?: string;
}

/** "Relatório Março/2026 (final).pdf" → "Relatorio-Marco-2026-final.pdf" (só para a chave no storage). */
export function safeKeyName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'arquivo';
  const clean = base.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (clean || 'arquivo').slice(-100);
}

const displayName = (filename: string) => (filename.split(/[\\/]/).pop() ?? 'arquivo').trim().slice(0, 255) || 'arquivo';

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Upload direto para o S3 por URL pré-assinada (a API não trafega o arquivo).
   * A chave começa com tenant/chamado: no confirm só aceitamos chaves desse prefixo.
   */
  presign(user: TenantUser, ticketId: string, dto: PresignDto): Promise<{ uploadUrl: string; storageKey: string; headers: Record<string, string>; expiresIn: number }> {
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      await this.assertTicketVisible(tx, ticketId);
      const storageKey = `${user.tenantId}/${ticketId}/${randomUUID()}-${safeKeyName(dto.filename)}`;
      const uploadUrl = await this.storage.presignUpload(storageKey, dto.contentType, dto.size);
      return { uploadUrl, storageKey, headers: { 'Content-Type': dto.contentType }, expiresIn: 600 };
    });
  }

  confirm(user: TenantUser, ticketId: string, dto: ConfirmDto): Promise<TicketAttachment> {
    if (!dto.storageKey.startsWith(`${user.tenantId}/${ticketId}/`) || dto.storageKey.includes('..')) {
      throw new AppException(422, 'invalid_reference', 'Arquivo enviado não pertence a este chamado.');
    }
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      await this.assertTicketVisible(tx, ticketId);
      const obj = await this.storage.head(dto.storageKey);
      if (!obj) throw new AppException(422, 'invalid_reference', 'O arquivo não foi encontrado no armazenamento. Envie de novo.');
      if (obj.size !== dto.size || (obj.contentType && obj.contentType !== dto.contentType)) {
        throw new AppException(422, 'invalid_value', 'O arquivo enviado não confere com o informado.');
      }
      // RLS: o anexo só entra se o usuário enxerga o chamado (e a mensagem, se informada)
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO attachments (tenant_id, ticket_id, message_id, filename, content_type, size_bytes, storage_key, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [user.tenantId, ticketId, dto.messageId ?? null, displayName(dto.filename), dto.contentType, dto.size, dto.storageKey, user.userId],
      );
      return this.fetch(tx, rows[0]!.id);
    });
  }

  /** URL de download de curta duração, emitida só depois de a RLS confirmar que o usuário enxerga o anexo. */
  download(user: TenantUser, id: string): Promise<{ url: string; filename: string; expiresIn: number }> {
    return this.db.withTenant(tenantCtx(user), async (tx) => {
      const { rows } = await tx.query<{ storage_key: string; filename: string }>('SELECT storage_key, filename FROM attachments WHERE id = $1', [id]);
      const a = rows[0];
      if (!a) throw new AppException(404, 'not_found', 'Anexo não encontrado.');
      return { url: await this.storage.presignDownload(a.storage_key, a.filename), filename: a.filename, expiresIn: 300 };
    });
  }

  remove(user: TenantUser, id: string): Promise<void> {
    return this.db
      .withTenant(tenantCtx(user), async (tx) => {
        // policy attachments_delete: equipe ou quem enviou
        const { rows } = await tx.query<{ storage_key: string }>('DELETE FROM attachments WHERE id = $1 RETURNING storage_key', [id]);
        if (rows[0]) return rows[0].storage_key;
        const visible = await tx.query('SELECT 1 FROM attachments WHERE id = $1', [id]);
        if (visible.rowCount) throw new AppException(403, 'forbidden', 'Você não pode remover este anexo.');
        throw new AppException(404, 'not_found', 'Anexo não encontrado.');
      })
      .then((key) => this.storage.remove(key)); // depois do COMMIT: o registro nunca aponta para objeto apagado
  }

  private async assertTicketVisible(tx: Tx, ticketId: string): Promise<void> {
    const r = await tx.query('SELECT 1 FROM tickets WHERE id = $1', [ticketId]);
    if (!r.rowCount) throw new AppException(404, 'not_found', 'Chamado não encontrado.');
  }

  private async fetch(tx: Tx, id: string): Promise<TicketAttachment> {
    const { rows } = await tx.query<{ id: string; message_id: string | null; filename: string; content_type: string; size_bytes: string; uploaded_by: string; name: string | null; created_at: Date }>(
      `SELECT a.id, a.message_id, a.filename, a.content_type, a.size_bytes, a.uploaded_by, u.name, a.created_at
         FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.id = $1`,
      [id],
    );
    const a = rows[0]!;
    return {
      id: a.id, messageId: a.message_id, filename: a.filename, contentType: a.content_type, sizeBytes: Number(a.size_bytes),
      uploadedBy: a.name !== null ? { id: a.uploaded_by, name: a.name } : null, createdAt: a.created_at.toISOString(),
    };
  }
}

const uuid = new ParseUUIDPipe();

@ApiTags('attachments')
@ApiBearerAuth()
@Controller()
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post('tickets/:id/attachments/presign') @HttpCode(200)
  presign(@CurrentTenantUser() u: TenantUser, @Param('id', uuid) id: string, @Body() d: PresignDto) { return this.attachments.presign(u, id, d); }

  @Post('tickets/:id/attachments/confirm')
  confirm(@CurrentTenantUser() u: TenantUser, @Param('id', uuid) id: string, @Body() d: ConfirmDto) { return this.attachments.confirm(u, id, d); }

  @Get('attachments/:id/download')
  download(@CurrentTenantUser() u: TenantUser, @Param('id', uuid) id: string) { return this.attachments.download(u, id); }

  @Delete('attachments/:id') @HttpCode(204)
  remove(@CurrentTenantUser() u: TenantUser, @Param('id', uuid) id: string) { return this.attachments.remove(u, id); }
}
