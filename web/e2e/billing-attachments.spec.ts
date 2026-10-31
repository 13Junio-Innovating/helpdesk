import { expect, test, type Page } from '@playwright/test';
import { call, cleanup, createWorkspace, db, DOMAIN, lastToken, PW, uiLogin } from './support';

async function login(page: Page, email: string, password = PW) {
  await uiLogin(page, email, password);
  await expect(page).not.toHaveURL(/\/entrar/);
}

/** Workspace com admin e um cliente (convite aceito). */
async function workspace(slug: string) {
  const admin = `admin-${slug}@${DOMAIN}`;
  const customer = `cliente-${slug}@${DOMAIN}`;
  const ws = await createWorkspace(slug, admin);
  await call('/invitations', { method: 'POST', token: ws.token, body: { email: customer, role: 'requester' } });
  await call('/auth/accept-invite', { method: 'POST', body: { token: await lastToken('invitation', customer), name: 'Cléo Cliente', password: PW } });
  return { ...ws, admin, customer };
}

test.beforeAll(cleanup);
test.afterAll(async () => {
  await db.query(`DELETE FROM billing_events WHERE provider = 'fake' AND payload::text LIKE '%e2e%'`).catch(() => undefined);
  await cleanup();
});

test.describe('Anexos', () => {
  test('cliente anexa ao abrir o chamado; equipe vê, baixa e anexa por arrastar/escolher; tipo proibido é recusado', async ({ page, browser }) => {
    const s = await workspace('e2e-anexos-web');
    await login(page, s.customer);
    await page.getByRole('link', { name: 'Abrir chamado' }).first().click();
    await page.getByLabel('Assunto').fill('Erro na nota fiscal');
    await page.getByLabel('Descrição').fill('Segue o PDF com a mensagem de erro.');
    await page.getByText('Anexar arquivos (opcional)').locator('input[type=file]').setInputFiles({ name: 'erro-nota.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 nota com erro') });
    await expect(page.getByRole('list', { name: 'Arquivos para anexar' })).toContainText('erro-nota.pdf');
    await page.getByRole('button', { name: 'Enviar chamado' }).click();
    await expect(page.getByText(/Chamado #1 aberto/)).toBeVisible();
    const anexos = page.getByRole('region', { name: 'Anexos' });
    await expect(anexos.getByText('erro-nota.pdf')).toBeVisible();
    const ticketId = page.url().split('/').pop()!;

    // equipe (admin) vê e baixa
    const staffCtx = await browser.newContext({ locale: 'pt-BR' });
    const staff = await staffCtx.newPage();
    await login(staff, s.admin);
    await staff.goto(`/chamados/${ticketId}`);
    const staffAnexos = staff.getByRole('region', { name: 'Anexos' });
    await expect(staffAnexos.getByText('erro-nota.pdf')).toBeVisible();
    const [download] = await Promise.all([staff.waitForEvent('download'), staffAnexos.getByRole('button', { name: 'Baixar erro-nota.pdf' }).click()]);
    expect(download.suggestedFilename()).toBe('erro-nota.pdf');
    const chunks: Buffer[] = [];
    for await (const c of (await download.createReadStream())!) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('%PDF-1.4 nota com erro');

    // equipe anexa uma planilha; tipo proibido (SVG) é recusado no navegador
    await staffAnexos.getByLabel('Anexar arquivos').setInputFiles([
      { name: 'logs.csv', mimeType: 'text/csv', buffer: Buffer.from('data;erro\n2026-10-30;timeout') },
      { name: 'desenho.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') },
    ]);
    await expect(staff.getByText('desenho.svg: tipo de arquivo não permitido.')).toBeVisible();
    await expect(staffAnexos.getByText('logs.csv')).toBeVisible();
    await expect(staffAnexos.getByRole('heading', { name: 'Anexos (2)' })).toBeVisible();

    // o cliente também vê a planilha da equipe (anexo do chamado, não de nota interna)
    await page.reload();
    await expect(anexos.getByText('logs.csv')).toBeVisible();
    await staffCtx.close();
  });
});

test.describe('Planos e cobrança (provedor de teste)', () => {
  test('página de preços pública lista os 3 planos', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/precos$/);
    const plans = page.getByRole('list', { name: 'Planos' });
    await expect(plans.locator(':scope > li')).toHaveCount(3);
    await expect(plans).toContainText('Starter');
    await expect(plans).toContainText('R$ 99,00');
    await plans.getByRole('link', { name: 'Começar teste grátis' }).first().click();
    await expect(page).toHaveURL(/\/cadastro$/);
  });

  test('admin assina o Pro pelo checkout e o plano muda só depois do webhook', async ({ page }) => {
    const s = await workspace('e2e-assina-web');
    await login(page, s.admin);
    await page.goto('/configuracoes/plano');
    await expect(page.getByText('Período de teste')).toBeVisible();
    await page.getByRole('button', { name: 'Assinar Pro' }).click();
    await expect(page).toHaveURL(/\/assinatura\/simulada\?session=/);
    expect((await db.query(`SELECT plan_id FROM tenants WHERE id = $1`, [s.tenantId])).rows[0].plan_id).toBe('starter');

    await page.getByRole('button', { name: 'Simular pagamento aprovado' }).click();
    await expect(page).toHaveURL(/\/configuracoes\/plano$/);
    await expect(page.getByText('Pagamento aprovado: plano Pro ativo.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Plano atual' })).toBeVisible();
    await expect(page.getByText('Situação: Ativa')).toBeVisible();
    expect((await db.query(`SELECT status, plan_id FROM tenants WHERE id = $1`, [s.tenantId])).rows[0]).toEqual({ status: 'active', plan_id: 'pro' });
  });

  test('cota esgotada: o erro 402 traz o atalho para o upgrade', async ({ page }) => {
    const s = await workspace('e2e-cota-web');
    await db.query(`INSERT INTO plans (id, name, price_cents, max_tickets_per_month) VALUES ('e2e-um', 'Um', 0, 1) ON CONFLICT DO NOTHING`);
    await call('/tickets', { method: 'POST', token: s.token, body: { subject: 'único do mês' } });
    await db.query(`UPDATE tenants SET plan_id = 'e2e-um' WHERE id = $1`, [s.tenantId]);

    await login(page, s.admin);
    await page.goto('/chamados/novo');
    await page.getByLabel('Buscar cliente').fill('Cléo');
    await page.getByLabel('Cliente', { exact: true }).selectOption({ label: `Cléo Cliente — ${s.customer}` });
    await page.getByLabel('Assunto').fill('Além da cota');
    await page.getByRole('button', { name: 'Criar chamado' }).click();
    await expect(page.getByRole('alert')).toContainText('limite de chamados');
    await page.getByRole('link', { name: 'Ver planos e fazer upgrade' }).click();
    await expect(page).toHaveURL(/\/configuracoes\/plano$/);
    await db.query(`UPDATE tenants SET plan_id = 'starter' WHERE id = $1`, [s.tenantId]);
  });
});
