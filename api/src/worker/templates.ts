/**
 * Templates dos e-mails da outbox. Todo conteúdo vindo de usuários (assunto, mensagem, nomes) é
 * escapado no HTML e tem quebras de linha removidas no assunto (sem injeção de cabeçalho).
 */
export interface MailContext {
  appUrl: string;
  tenantName: string | null;
  /** Corpo da mensagem pública (ticket_reply). */
  messageBody?: string | null;
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

export class UnknownTemplateError extends Error {}

type Payload = Record<string, unknown>;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : fallback);
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const ROLE_PT: Record<string, string> = { admin: 'administrador(a)', agent: 'agente', requester: 'cliente' };
const KIND_PT: Record<string, string> = { first_response: 'primeira resposta', resolution: 'resolução' };

function layout(title: string, paragraphs: string[], link?: { href: string; label: string }): { text: string; html: string } {
  const text = [...paragraphs, ...(link ? [`${link.label}: ${link.href}`] : [])].join('\n\n');
  const html = `<!doctype html><html lang="pt-BR"><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#0f172a">
<h2 style="margin:0 0 16px">${escapeHtml(title)}</h2>
${paragraphs.map((p) => `<p style="white-space:pre-wrap">${escapeHtml(p)}</p>`).join('\n')}
${link ? `<p><a href="${escapeHtml(link.href)}" style="background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${escapeHtml(link.label)}</a></p>` : ''}
</body></html>`;
  return { text, html };
}

export function renderTemplate(template: string, payload: Payload, ctx: MailContext): RenderedMail {
  const tenant = ctx.tenantName ? `[${oneLine(ctx.tenantName)}] ` : '';
  const number = str(payload.number);
  const subjectText = oneLine(str(payload.subject));
  const ticketUrl = `${ctx.appUrl}/tickets/${encodeURIComponent(str(payload.ticket_id))}`;

  switch (template) {
    case 'ticket_created': {
      const b = layout(`Recebemos seu chamado #${number}`, [
        `Seu chamado "${subjectText}" foi registrado com o número #${number}.`,
        'Nossa equipe vai responder em breve. Você pode acompanhar e responder pelo portal.',
      ], { href: ticketUrl, label: 'Ver chamado' });
      return { subject: `${tenant}Chamado #${number} recebido: ${subjectText}`, ...b };
    }
    case 'ticket_reply': {
      const b = layout(`Nova resposta no chamado #${number}`, [
        `Há uma nova resposta no seu chamado "${subjectText}":`,
        str(ctx.messageBody, '(abra o chamado para ver a mensagem)').slice(0, 20000),
      ], { href: ticketUrl, label: 'Responder' });
      return { subject: `${tenant}Re: Chamado #${number} ${subjectText}`, ...b };
    }
    case 'invitation': {
      const workspace = oneLine(str(payload.tenant_name, 'um workspace'));
      const by = str(payload.invited_by);
      const b = layout(`Convite para ${workspace}`, [
        `${by ? `${by} convidou você` : 'Você foi convidado(a)'} para entrar em ${workspace} como ${ROLE_PT[str(payload.role)] ?? 'membro'}.`,
        'O link vale por 7 dias e só pode ser usado uma vez.',
      ], { href: `${ctx.appUrl}/accept-invite?token=${encodeURIComponent(str(payload.token))}`, label: 'Aceitar convite' });
      return { subject: `Convite para ${workspace}`, ...b };
    }
    case 'password_reset': {
      const b = layout('Redefinição de senha', [
        `Olá${payload.name ? `, ${str(payload.name)}` : ''}. Recebemos um pedido para redefinir sua senha.`,
        'O link vale por 1 hora. Se não foi você, ignore este e-mail: sua senha continua a mesma.',
      ], { href: `${ctx.appUrl}/reset-password?token=${encodeURIComponent(str(payload.token))}`, label: 'Criar nova senha' });
      return { subject: 'Redefinição de senha', ...b };
    }
    case 'sla_warning': {
      const kind = KIND_PT[str(payload.kind)] ?? 'SLA';
      const due = new Date(str(payload.due_at));
      const when = Number.isNaN(due.getTime()) ? '' : ` em ${due.toLocaleString('pt-BR', { timeZone: str(payload.timezone, 'America/Sao_Paulo') })}`;
      const b = layout(`SLA perto de vencer: chamado #${number}`, [
        `O prazo de ${kind} do chamado "${subjectText}" vence${when}.`,
      ], { href: ticketUrl, label: 'Abrir chamado' });
      return { subject: `${tenant}SLA de ${kind} perto de vencer: #${number}`, ...b };
    }
    case 'staff_notification': {
      const rule = oneLine(str(payload.rule, 'automação'));
      const b = layout(`Chamado #${number} requer atenção`, [
        `A regra "${rule}" sinalizou o chamado "${subjectText}".`,
      ], { href: ticketUrl, label: 'Abrir chamado' });
      return { subject: `${tenant}Atenção: chamado #${number} ${subjectText}`, ...b };
    }
    default:
      throw new UnknownTemplateError(`template desconhecido: ${template}`);
  }
}
