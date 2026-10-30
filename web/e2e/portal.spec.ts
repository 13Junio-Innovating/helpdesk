import { expect, test } from '@playwright/test';
import { apiLogin, call, cleanup, createWorkspace, db, DOMAIN, lastToken, PW, uiLogin, uiLogout } from './support';

test.beforeAll(cleanup);
// o pool do banco é compartilhado entre os arquivos do mesmo worker: não fechar aqui
test.afterAll(cleanup);

test.describe('Portal do cliente', () => {
  test('fluxo completo: convite → login → abrir chamado → ver resposta → responder', async ({ page }) => {
    // ---- preparação (admin do workspace, pela API) ----
    const ws = await createWorkspace('e2e-portal', `admin-portal@${DOMAIN}`);
    await call('/kb', {
      method: 'POST',
      token: ws.token,
      body: { title: 'Como redefinir a senha do e-mail', body: 'Acesse **Configurações > Segurança** e clique em *Redefinir*.', status: 'published', visibility: 'portal' },
    });
    const email = `cliente-portal@${DOMAIN}`;
    await call('/invitations', { method: 'POST', token: ws.token, body: { email, role: 'requester' } });
    const token = await lastToken('invitation', email);

    // ---- convite ----
    await page.goto(`/convite?token=${encodeURIComponent(token)}`);
    await expect(page.getByRole('heading', { name: 'Aceitar convite' })).toBeVisible();
    await page.getByLabel('Seu nome').fill('Clara Cliente');
    await page.getByLabel('Senha', { exact: true }).fill(PW);
    await page.getByLabel('Confirme a senha').fill(PW);
    await page.getByRole('button', { name: 'Aceitar e entrar' }).click();
    await expect(page).toHaveURL(/\/portal$/);
    await expect(page.getByRole('heading', { name: 'Meus chamados' })).toBeVisible();
    await expect(page.getByText('Nenhum chamado em aberto')).toBeVisible();

    // ---- sair e entrar de novo com a senha criada ----
    await uiLogout(page);
    await uiLogin(page, email, PW);
    await expect(page).toHaveURL(/\/portal$/);

    // ---- abrir chamado (com sugestão da base enquanto digita) ----
    await page.getByRole('link', { name: 'Abrir chamado' }).first().click();
    await page.getByLabel('Assunto').fill('Não consigo redefinir a senha');
    const suggestions = page.getByRole('complementary', { name: 'Artigos sugeridos' });
    await expect(suggestions.getByText('Isto pode resolver')).toBeVisible();
    await expect(suggestions.getByRole('link', { name: /Como redefinir a senha do e-mail/ })).toBeVisible();
    // cliente não vê campos de prioridade/responsável
    await expect(page.getByLabel(/Prioridade|Responsável/)).toHaveCount(0);
    await page.getByLabel('Descrição').fill('Tentei pelo celular e não recebi o código.');
    await page.getByRole('button', { name: 'Enviar chamado' }).click();
    await expect(page.getByText(/Chamado #1 aberto/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Não consigo redefinir a senha' })).toBeVisible();
    const ticketId = page.url().split('/').pop()!;

    // ---- equipe responde (pela API): resposta pública + nota interna ----
    await call(`/tickets/${ticketId}/messages`, { method: 'POST', token: ws.token, body: { kind: 'internal_note', body: 'NOTA-SECRETA: verificar SMS' } });
    await call(`/tickets/${ticketId}/messages`, { method: 'POST', token: ws.token, body: { kind: 'public_reply', body: 'Olá Clara! Enviamos um novo código.' } });

    await page.reload();
    const conversation = page.getByRole('region', { name: 'Conversa' });
    await expect(conversation.getByText('Olá Clara! Enviamos um novo código.')).toBeVisible();
    await expect(page.getByText('NOTA-SECRETA')).toHaveCount(0);

    // ---- cliente responde ----
    await page.getByLabel('Responder').fill('Recebi, funcionou. Obrigada!');
    await page.getByRole('button', { name: 'Enviar resposta' }).click();
    await expect(conversation.getByText('Recebi, funcionou. Obrigada!')).toBeVisible();
    await expect(conversation.getByText('Você').last()).toBeVisible();
    await expect(page.getByLabel('Responder')).toHaveValue('');

    // ---- aparece na lista ----
    await page.getByRole('link', { name: 'Meus chamados' }).first().click();
    await expect(page.getByRole('list', { name: 'Chamados' }).getByText('Não consigo redefinir a senha')).toBeVisible();

    // a mensagem chegou de verdade no banco como resposta pública do cliente
    const { rows } = await db.query(`SELECT kind FROM ticket_messages WHERE ticket_id = $1 AND body = 'Recebi, funcionou. Obrigada!'`, [ticketId]);
    expect(rows).toEqual([{ kind: 'public_reply' }]);
  });

  test('cadastro self-service cria o workspace em trial e entra como admin', async ({ page }) => {
    await page.goto('/cadastro');
    await page.getByLabel('Nome da empresa').fill('Padaria Pão Quente');
    await expect(page.getByLabel('Endereço do workspace')).toHaveValue('padaria-pao-quente');
    await page.getByLabel('Endereço do workspace').fill('e2e-padaria');
    await page.getByLabel('Seu nome').fill('Paula Padeira');
    await page.getByLabel('E-mail').fill(`paula@${DOMAIN}`);
    await page.getByLabel('Senha').fill('curta');
    await page.getByRole('button', { name: 'Criar workspace' }).click();
    await expect(page.getByText('A senha precisa ter pelo menos 8 caracteres')).toBeVisible();

    await page.getByLabel('Senha').fill(PW);
    await page.getByRole('button', { name: 'Criar workspace' }).click();
    await expect(page).toHaveURL(/\/painel$/);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Menu da conta' })).toContainText('Paula Padeira');
    const { rows } = await db.query(`SELECT status, trial_ends_at > now() + interval '13 days' AS trial FROM tenants WHERE slug = 'e2e-padaria'`);
    expect(rows[0]).toEqual({ status: 'trial', trial: true });

    // endereço em uso
    await uiLogout(page);
    await page.goto('/cadastro');
    await page.getByLabel('Nome da empresa').fill('Outra');
    await page.getByLabel('Endereço do workspace').fill('e2e-padaria');
    await page.getByLabel('Seu nome').fill('Outra Pessoa');
    await page.getByLabel('E-mail').fill(`outra@${DOMAIN}`);
    await page.getByLabel('Senha').fill(PW);
    await page.getByRole('button', { name: 'Criar workspace' }).click();
    await expect(page.getByText('Este endereço de workspace já está em uso.')).toBeVisible();
  });

  test('cliente do seed vê só os próprios chamados e não entra no painel da equipe', async ({ page }) => {
    await uiLogin(page, 'joao@acme.local', 'demo1234');
    await expect(page).toHaveURL(/\/portal$/);
    const list = page.getByRole('list', { name: 'Chamados' });
    await expect(list.getByRole('listitem')).toHaveCount(3); // em aberto
    await page.getByRole('tab', { name: 'Todos' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(4);
    await expect(list.getByText('Sistema fora do ar para toda a filial')).toHaveCount(0); // chamado do Pedro

    await page.goto('/painel');
    await expect(page).toHaveURL(/\/portal$/);

    // sessão sobrevive ao recarregar (refresh por cookie httpOnly; token só em memória)
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Meus chamados' })).toBeVisible();
    expect(await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage) + document.cookie)).not.toMatch(/eyJ|hd_rt/);
  });

  test('senha errada mostra erro; login com vários workspaces pede a escolha', async ({ page }) => {
    await uiLogin(page, 'joao@acme.local', 'errada');
    await expect(page.getByRole('alert')).toHaveText('E-mail ou senha incorretos.');

    const other = await createWorkspace('e2e-segundo', `admin-segundo@${DOMAIN}`);
    await db.query(`INSERT INTO memberships (tenant_id, user_id, role) SELECT $1, id, 'requester' FROM users WHERE email = 'joao@acme.local'`, [other.tenantId]);

    await uiLogin(page, 'joao@acme.local', 'demo1234');
    await expect(page.getByRole('heading', { name: 'Escolha o workspace' })).toBeVisible();
    await page.getByRole('button', { name: /Empresa e2e-segundo/ }).click();
    await expect(page).toHaveURL(/\/portal$/);
    await expect(page.getByText('Nenhum chamado em aberto')).toBeVisible();
    await expect(page.getByRole('banner').getByText('Empresa e2e-segundo')).toBeVisible();

    // troca para o outro workspace sem sair
    await page.getByRole('button', { name: 'Menu da conta' }).click();
    await page.getByRole('menuitem', { name: 'Trocar de workspace' }).click();
    await page.getByRole('button', { name: /Demo Suporte/ }).click();
    await expect(page.getByRole('banner').getByText('Demo Suporte')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Chamados' }).getByRole('listitem')).toHaveCount(3);
  });

  test('esqueci a senha → link do e-mail → nova senha', async ({ page }) => {
    const email = `esqueci@${DOMAIN}`;
    await createWorkspace('e2e-esqueci', email);
    await page.goto('/esqueci-senha');
    await page.getByLabel('E-mail').fill(email);
    await page.getByRole('button', { name: 'Enviar link' }).click();
    await expect(page.getByText(/Se o e-mail estiver cadastrado/)).toBeVisible();

    await page.goto(`/redefinir-senha?token=${encodeURIComponent(await lastToken('password_reset', email))}`);
    await page.getByLabel('Nova senha', { exact: true }).fill('nova-senha-456');
    await page.getByLabel('Confirme a nova senha').fill('outra-coisa');
    await page.getByRole('button', { name: 'Salvar senha' }).click();
    await expect(page.getByText('As senhas não conferem')).toBeVisible();
    await page.getByLabel('Confirme a nova senha').fill('nova-senha-456');
    await page.getByRole('button', { name: 'Salvar senha' }).click();
    await expect(page.getByText(/Senha alterada/)).toBeVisible();

    await uiLogin(page, email, 'nova-senha-456');
    await expect(page).toHaveURL(/\/painel$/);
  });

  test('cota do plano esgotada: mensagem clara ao abrir chamado', async ({ page }) => {
    const ws = await createWorkspace('e2e-cota', `admin-cota@${DOMAIN}`);
    const email = `cliente-cota@${DOMAIN}`;
    await call('/invitations', { method: 'POST', token: ws.token, body: { email, role: 'requester' } });
    await call('/auth/accept-invite', { method: 'POST', body: { token: await lastToken('invitation', email), name: 'Cliente Cota', password: PW } });
    await db.query(`INSERT INTO plans (id, name, price_cents, max_tickets_per_month) VALUES ('e2e-zero', 'Zero', 0, 1)`);
    await call('/tickets', { method: 'POST', token: await apiLogin(email, PW), body: { subject: 'Primeiro e único' } });
    await db.query(`UPDATE tenants SET plan_id = 'e2e-zero' WHERE id = $1`, [ws.tenantId]);

    await uiLogin(page, email, PW);
    await page.getByRole('link', { name: 'Abrir chamado' }).first().click();
    await page.getByLabel('Assunto').fill('Segundo chamado');
    await page.getByLabel('Descrição').fill('Isto deve estourar a cota do plano.');
    await page.getByRole('button', { name: 'Enviar chamado' }).click();
    await expect(page.getByRole('alert')).toContainText('atingiu o limite de chamados');
  });

  test('tema escuro, navegação por teclado e layout no celular', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await uiLogin(page, 'maria@acme.local', 'demo1234');
    await expect(page.getByRole('navigation', { name: 'Principal (celular)' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    // ciclo: sistema → claro → escuro
    const html = page.locator('html');
    await page.getByRole('button', { name: /Tema do sistema/ }).click();
    await expect(html).not.toHaveClass(/dark/);
    await page.getByRole('button', { name: /Tema claro/ }).click();
    await expect(html).toHaveClass(/dark/);
    await page.reload();
    await expect(html).toHaveClass(/dark/); // preferência lembrada (aplicada antes do primeiro paint)

    // "pular para o conteúdo" é o primeiro foco
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Pular para o conteúdo' })).toBeFocused();
  });
});
