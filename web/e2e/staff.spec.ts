import { expect, test, type Browser, type Page } from '@playwright/test';
import { apiLogin, call, cleanup, createWorkspace, db, DOMAIN, lastToken, PW, uiLogin } from './support';

interface Setup {
  tenantId: string;
  admin: string; // tokens
  agent: string;
  customer: string;
  emails: { admin: string; agent: string; customer: string };
}

/** Workspace novo com admin, agente e cliente (convites aceitos pela API). */
async function workspace(slug: string): Promise<Setup> {
  const emails = { admin: `admin-${slug}@${DOMAIN}`, agent: `agente-${slug}@${DOMAIN}`, customer: `cliente-${slug}@${DOMAIN}` };
  const ws = await createWorkspace(slug, emails.admin);
  for (const [email, role, name] of [[emails.agent, 'agent', 'Ágata Agente'], [emails.customer, 'requester', 'Caio Cliente']] as const) {
    await call('/invitations', { method: 'POST', token: ws.token, body: { email, role } });
    await call('/auth/accept-invite', { method: 'POST', body: { token: await lastToken('invitation', email), name, password: PW } });
  }
  return { tenantId: ws.tenantId, admin: ws.token, agent: await apiLogin(emails.agent, PW), customer: await apiLogin(emails.customer, PW), emails };
}

/** Login pela tela, esperando sair de /entrar (antes de qualquer page.goto). */
async function login(page: Page, email: string, password = PW): Promise<void> {
  await uiLogin(page, email, password);
  await expect(page).not.toHaveURL(/\/entrar/);
}

async function customerPage(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ locale: 'pt-BR' });
  const page = await ctx.newPage();
  await login(page, email);
  await expect(page).toHaveURL(/\/portal$/);
  return page;
}

test.beforeAll(cleanup);
// o pool do banco é compartilhado entre os arquivos do mesmo worker: não fechar aqui
test.afterAll(cleanup);

test.describe('Painel da equipe', () => {
  test('aceite: filtrar "SLA vencido" → abrir → nota interna (cliente não vê) → resolver → reabrir', async ({ page, browser }) => {
    const s = await workspace('e2e-painel');
    const late = await call<{ id: string; number: number }>('/tickets', { method: 'POST', token: s.customer, body: { subject: 'Servidor de arquivos lento', description: 'Demora para abrir pastas.' } });
    await call('/tickets', { method: 'POST', token: s.customer, body: { subject: 'Dúvida sobre fatura' } });
    await db.query(`UPDATE sla_timers SET due_at = now() - interval '2 hours' WHERE ticket_id = $1 AND kind = 'resolution'`, [late.id]);

    await login(page, s.emails.agent);
    await expect(page).toHaveURL(/\/painel$/);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Chamados' }).click();
    await page.getByRole('button', { name: 'SLA vencido' }).click();
    await expect(page).toHaveURL(/visao=sla-vencido/);
    const table = page.getByRole('table');
    await expect(table.getByRole('row')).toHaveCount(2); // cabeçalho + 1
    await expect(table.getByText('Servidor de arquivos lento')).toBeVisible();
    await expect(table.getByText('Dúvida sobre fatura')).toHaveCount(0);
    await expect(table.getByText(/Estourado/)).toBeVisible();

    await table.getByRole('link', { name: /Servidor de arquivos lento/ }).click();
    await expect(page.getByRole('heading', { name: 'Servidor de arquivos lento' })).toBeVisible();

    // padrão seguro: o editor começa em "Nota interna"
    await expect(page.getByRole('radio', { name: 'Nota interna' })).toHaveAttribute('aria-checked', 'true');
    await page.getByLabel('Nota interna', { exact: true }).fill('NOTA-INTERNA: disco do servidor 2 com 98%');
    await page.getByRole('button', { name: 'Salvar nota interna' }).click();
    const timeline = page.getByRole('region', { name: 'Linha do tempo' });
    await expect(timeline.getByText('NOTA-INTERNA: disco do servidor 2 com 98%')).toBeVisible();
    await expect(timeline.getByText('Nota interna').first()).toBeVisible();

    // resolver
    await page.getByRole('button', { name: 'Resolver' }).click();
    await expect(page.getByLabel('Status')).toHaveValue(/.+/);
    await expect(page.locator('main').getByText('Resolvido').first()).toBeVisible();
    await expect(timeline.getByText(/mudou o status de "Novo" para "Resolvido"/)).toBeVisible();

    // o cliente vê o chamado resolvido, mas NUNCA a nota interna
    const customer = await customerPage(browser, s.emails.customer);
    await customer.goto(`/portal/chamados/${late.id}`);
    await expect(customer.getByRole('heading', { name: 'Servidor de arquivos lento' })).toBeVisible();
    await expect(customer.getByText(/Este chamado foi resolvido/)).toBeVisible();
    await expect(customer.getByText('NOTA-INTERNA')).toHaveCount(0);
    expect(await customer.content()).not.toContain('disco do servidor 2');

    // reabrir
    await page.getByRole('button', { name: 'Reabrir' }).click();
    await expect(timeline.getByText(/para "Em atendimento"/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resolver' })).toBeVisible();
    const { rows } = await db.query(`SELECT s.kind, t.resolved_at FROM tickets t JOIN statuses s ON s.id = t.status_id WHERE t.id = $1`, [late.id]);
    expect(rows[0]).toEqual({ kind: 'open', resolved_at: null });
  });

  test('resposta pública mostra o destinatário antes de enviar e chega ao cliente', async ({ page, browser }) => {
    const s = await workspace('e2e-resposta');
    const t = await call<{ id: string }>('/tickets', { method: 'POST', token: s.customer, body: { subject: 'Impressora sem toner' } });
    await call('/catalog/macros', { method: 'POST', token: s.admin, body: { title: 'Saudação', body: 'Olá! Já estamos cuidando disso.' } });

    await login(page, s.emails.agent);
    await page.goto(`/chamados/${t.id}`);
    await page.getByRole('radio', { name: 'Resposta pública' }).click();
    await expect(page.getByText(`Será enviada por e-mail para Caio Cliente <${s.emails.customer}>`)).toBeVisible();
    await page.getByLabel('Inserir resposta pronta').selectOption({ label: 'Saudação' });
    await expect(page.getByLabel('Resposta ao cliente')).toHaveValue('Olá! Já estamos cuidando disso.');
    await page.getByRole('button', { name: 'Enviar ao cliente' }).click();
    await expect(page.getByText('Resposta enviada ao cliente.')).toBeVisible();
    // volta ao padrão seguro depois de enviar
    await expect(page.getByRole('radio', { name: 'Nota interna' })).toHaveAttribute('aria-checked', 'true');

    const customer = await customerPage(browser, s.emails.customer);
    await customer.goto(`/portal/chamados/${t.id}`);
    await expect(customer.getByText('Olá! Já estamos cuidando disso.')).toBeVisible();
  });

  test('ações em lote, atalhos de teclado e status otimista com rollback', async ({ page }) => {
    const s = await workspace('e2e-lote');
    for (const subject of ['Lote um', 'Lote dois', 'Lote três']) await call('/tickets', { method: 'POST', token: s.customer, body: { subject } });

    await login(page, s.emails.agent);
    await page.goto('/chamados?visao=sem-responsavel&assignee=none&status=open,pending,on_hold');
    const table = page.getByRole('table');
    await expect(table.getByRole('row')).toHaveCount(4);

    // atalhos
    await page.locator('body').press('?');
    await expect(page.getByRole('dialog', { name: 'Atalhos de teclado' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('body').press('j');
    await expect(table.getByRole('link').first()).toBeFocused();
    await page.keyboard.press('x');
    await page.keyboard.press('j');
    await page.keyboard.press('x');
    await expect(page.getByText('2 selecionado(s)')).toBeVisible();
    await page.locator('body').press('/');
    await expect(page.getByLabel(/Buscar chamados/)).toBeFocused();

    await page.getByRole('region', { name: 'Ações em lote' }).getByRole('button', { name: 'Atribuir a mim' }).click();
    await expect(page.getByText('2 chamado(s) atualizado(s).')).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(2); // sobrou 1 sem responsável

    // UI otimista: a API falha → o status volta e aparece o erro
    const ticket = await db.query<{ id: string }>(`SELECT t.id FROM tickets t WHERE t.tenant_id = $1 AND t.subject = 'Lote um'`, [s.tenantId]);
    await page.goto(`/chamados/${ticket.rows[0]!.id}`);
    const status = page.getByLabel('Status');
    const before = await status.inputValue();
    await page.route('**/api/v1/tickets/*', (route) => (route.request().method() === 'PATCH' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'internal_error', message: 'Falha simulada no servidor.' }) }) : route.continue()));
    await status.selectOption({ label: 'Em espera (pausa SLA)' });
    await expect(page.getByText('Falha simulada no servidor.')).toBeVisible();
    await expect(status).toHaveValue(before);
    await page.unroute('**/api/v1/tickets/*');
  });

  test('agente abre chamado em nome do cliente; horas apontadas', async ({ page }) => {
    const s = await workspace('e2e-novo');
    await login(page, s.emails.agent);
    await page.goto('/chamados/novo');
    await page.getByLabel('Buscar cliente').fill('Caio');
    await page.getByLabel('Cliente', { exact: true }).selectOption({ label: `Caio Cliente — ${s.emails.customer}` });
    await page.getByLabel('Assunto').fill('Ligação: VPN não conecta');
    await page.getByLabel('Prioridade').selectOption({ label: 'Alta' });
    await page.getByLabel('Responsável').selectOption({ label: 'Ágata Agente' });
    await page.getByRole('button', { name: 'Criar chamado' }).click();
    await expect(page.getByRole('heading', { name: 'Ligação: VPN não conecta' })).toBeVisible();
    await expect(page.getByText('via telefone', { exact: false })).toBeVisible();
    await expect(page.getByLabel('Prioridade')).toHaveValue(/.+/);

    await page.getByLabel('Minutos').fill('45');
    await page.getByLabel('Descrição do trabalho').fill('Reconfigurei o cliente VPN');
    await page.getByRole('button', { name: 'Apontar' }).click();
    await expect(page.getByText('Horas apontadas: 0h45')).toBeVisible();
  });

  test('admin: configurações (fila, prioridade padrão, convite) e base de conhecimento no portal', async ({ page, browser }) => {
    const s = await workspace('e2e-config');
    await login(page, s.emails.admin);
    await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Configurações' }).click();
    await expect(page).toHaveURL(/\/configuracoes\/equipe$/);
    await expect(page.getByText('Ágata Agente')).toBeVisible();

    await page.getByRole('link', { name: 'Filas' }).click();
    await page.getByRole('button', { name: 'Adicionar' }).click();
    await page.getByRole('dialog').getByLabel('Nome').fill('Financeiro');
    await page.getByRole('dialog').getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByRole('cell', { name: 'Financeiro', exact: true })).toBeVisible();

    // nome repetido: erro da API aparece no diálogo
    await page.getByRole('button', { name: 'Adicionar' }).click();
    await page.getByRole('dialog').getByLabel('Nome').fill('Financeiro');
    await page.getByRole('dialog').getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByRole('dialog').getByText('Já existe um registro com estes dados.')).toBeVisible();
    await page.keyboard.press('Escape');

    // remover a fila exige confirmação
    await page.getByRole('button', { name: 'Remover Financeiro' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remover' }).click();
    await expect(page.getByRole('cell', { name: 'Financeiro', exact: true })).toHaveCount(0);

    await page.getByRole('link', { name: 'Plano e uso' }).click();
    await expect(page.getByText('Starter')).toBeVisible();
    await expect(page.getByRole('meter').first()).toBeVisible();

    // KB: escreve, pré-visualiza, publica no portal → cliente encontra
    await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Base de conhecimento' }).click();
    await page.getByRole('link', { name: 'Novo artigo' }).click();
    await page.getByLabel('Título').fill('Como configurar a VPN');
    await page.getByLabel('Conteúdo (Markdown)').fill('1. Baixe o cliente\n2. Use **seu e-mail** como usuário');
    await page.getByRole('tab', { name: 'Pré-visualizar' }).click();
    await expect(page.locator('strong', { hasText: 'seu e-mail' })).toBeVisible();
    await page.getByLabel('Status').selectOption({ label: 'Publicado' });
    await page.getByLabel('Visibilidade').selectOption({ label: 'Portal do cliente' });
    await expect(page.getByText('Este artigo ficará visível para os clientes no portal.')).toBeVisible();
    await page.getByRole('button', { name: 'Salvar artigo' }).click();
    await expect(page.getByText('Artigo salvo.')).toBeVisible();
    await expect(page).toHaveURL(/\/base-de-conhecimento\/[0-9a-f-]{36}$/);

    const customer = await customerPage(browser, s.emails.customer);
    await customer.getByRole('link', { name: 'Central de ajuda' }).first().click();
    await customer.getByRole('link', { name: /Como configurar a VPN/ }).click();
    await expect(customer.locator('strong', { hasText: 'seu e-mail' })).toBeVisible();
  });

  test('agente não acessa configurações; dashboard do demo com dados e tabela alternativa', async ({ page }) => {
    await login(page, 'carlos@demo.local', 'demo1234');
    await expect(page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Configurações' })).toHaveCount(0);
    await page.goto('/configuracoes/filas');
    await expect(page).toHaveURL(/\/painel$/);

    await expect(page.getByText('Chamados abertos')).toBeVisible();
    await expect(page.getByRole('img', { name: /Chamados por dia/ })).toBeVisible();
    await page.getByRole('button', { name: 'Ver como tabela' }).click();
    await expect(page.locator('figure table tbody tr')).toHaveCount(30);
    await expect(page.getByRole('cell', { name: 'Carlos Souza' })).toBeVisible();
  });
});
