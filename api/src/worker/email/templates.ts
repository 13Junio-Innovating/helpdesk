/** Renderização dos e-mails da outbox (pt-BR). Tudo que vem do banco é escapado no HTML. */

export interface RenderContext {
  appUrl: string;
  tenantName: string | null;
  /** corpo da mensagem para ticket_reply (buscado pelo worker) */
  messageBody?: string | null;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

type Payload = Record<string, unknown>;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : fallback);
const ROLE: Record<string, string> = { admin: 'administrador(a)', agent: 'agente', requester: 'cliente' };
const TIMER: Record<string, string> = { first_response: 'primeira resposta', resolution: 'resolução' };

function layout(title: string, paragraphs: string[], cta?: { label: string; url: string }, footer?: string | null): RenderedEmail & { subject: '' } {
  const html = `<!doctype html><html lang="pt-BR"><body style="font-family:system-ui,sans-serif;color:#0f172a;max-width:560px;margin:0 auto;padding:24px">
<h1 style="font-size:20px">${esc(title)}</h1>
${paragraphs.map((p) => `<p style="line-height:1.5;white-space:pre-wrap">${esc(p)}</p>`).join('\n')}
${cta ? `<p><a href="${esc(cta.url)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${esc(cta.label)}</a></p>` : ''}
${footer ? `<p style="color:#64748b;font-size:12px">${esc(footer)}</p>` : ''}
</body></html>`;
  const text = [title, '', ...paragraphs, ...(cta ? ['', `${cta.label}: ${cta.url}`] : []), ...(footer ? ['', footer] : [])].join('\n');
  return { subject: '', text, html };
}

export function renderEmail(template: string, p: Payload, ctx: RenderContext): RenderedEmail {
  const ws = ctx.tenantName ?? 'Helpdesk';
  const num = str(p['number']);
  const subj = str(p['subject']);
  const ticketId = str(p['ticket_id']);
  const portalLink = `${ctx.appUrl}/portal/chamados/${ticketId}`;
  const staffLink = `${ctx.appUrl}/chamados/${ticketId}`;
  const footer = `${ws} · mensagem automática, não responda este e-mail.`;

  switch (template) {
    case 'ticket_created': {
      const r = layout(`Recebemos seu chamado #${num}`, [`Assunto: ${subj}`, 'Nossa equipe já foi avisada e responderá em breve.'], { label: 'Acompanhar chamado', url: portalLink }, footer);
      return { ...r, subject: `[${ws}] Chamado #${num} recebido: ${subj}` };
    }
    case 'ticket_reply': {
      const body = ctx.messageBody ? ctx.messageBody.slice(0, 4000) : 'Há uma nova resposta no seu chamado.';
      const r = layout(`Nova resposta no chamado #${num}`, [`Assunto: ${subj}`, body], { label: 'Ver e responder', url: portalLink }, footer);
      return { ...r, subject: `[${ws}] Re: #${num} ${subj}` };
    }
    case 'password_reset': {
      const url = `${ctx.appUrl}/redefinir-senha?token=${encodeURIComponent(str(p['token']))}`;
      const r = layout('Redefinição de senha', [`Olá, ${str(p['name'], '')}.`, 'Recebemos um pedido para redefinir sua senha. O link vale por 1 hora e só pode ser usado uma vez.', 'Se não foi você, ignore este e-mail.'], { label: 'Criar nova senha', url }, 'Helpdesk · mensagem automática.');
      return { ...r, subject: 'Redefinição de senha' };
    }
    case 'invitation': {
      const url = `${ctx.appUrl}/convite?token=${encodeURIComponent(str(p['token']))}`;
      const tenant = str(p['tenant_name'], ws);
      const r = layout(`Convite para ${tenant}`, [`${str(p['inviter_name'], 'Um administrador')} convidou você para entrar em ${tenant} como ${ROLE[str(p['role'])] ?? 'membro'}.`, 'O convite expira em 7 dias.'], { label: 'Aceitar convite', url }, `${tenant} · mensagem automática.`);
      return { ...r, subject: `Convite para ${tenant}` };
    }
    case 'sla_warning': {
      const r = layout(`SLA perto de vencer: #${num}`, [`Assunto: ${subj}`, `O prazo de ${TIMER[str(p['kind'])] ?? 'atendimento'} vence em ${new Date(str(p['due_at'])).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`], { label: 'Abrir chamado', url: staffLink }, footer);
      return { ...r, subject: `[${ws}] SLA perto de vencer: #${num} ${subj}` };
    }
    case 'notify_staff': {
      const r = layout(`Automação: chamado #${num}`, [`Assunto: ${subj}`, `A regra "${str(p['rule'])}" pediu atenção da equipe.`], { label: 'Abrir chamado', url: staffLink }, footer);
      return { ...r, subject: `[${ws}] Atenção: #${num} ${subj}` };
    }
    default:
      throw new Error(`template desconhecido: ${template}`);
  }
}
