-- Testes do banco. Rodar como SUPERUSUÁRIO (usa SET ROLE para simular sd_app / sd_worker).
--   psql "$PGSUPER_DB_URL" -v ON_ERROR_STOP=1 -q -f db/tests/test_db.sql
\set ON_ERROR_STOP on
SET client_min_messages = notice;

-- ---------- limpeza + helpers ----------
RESET ROLE;
SELECT delete_tenant(id) FROM tenants WHERE slug IN ('t-alpha', 't-beta');
DELETE FROM users   WHERE email LIKE '%.test.local';
DELETE FROM plans   WHERE id = 'qa-test';
DROP SCHEMA IF EXISTS tst CASCADE;
CREATE SCHEMA tst;
GRANT USAGE ON SCHEMA tst TO PUBLIC;

CREATE FUNCTION tst.ok(cond boolean, msg text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF cond IS DISTINCT FROM true THEN RAISE EXCEPTION 'FALHOU: %', msg; END IF;
  RAISE NOTICE 'ok  - %', msg;
END $f$;

CREATE FUNCTION tst.expect_error(p_sql text, p_state text, p_msg text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = p_state THEN
      RAISE NOTICE 'ok  - % (erro %)', p_msg, SQLSTATE;
      RETURN;
    END IF;
    RAISE EXCEPTION 'FALHOU: % (esperado %, veio %: %)', p_msg, p_state, SQLSTATE, SQLERRM;
  END;
  RAISE EXCEPTION 'FALHOU: % (nenhum erro)', p_msg;
END $f$;

-- ---------- cenário: dois tenants ----------
SELECT out_tenant_id AS ta, out_user_id AS ua
  FROM signup_tenant('Alpha Ltda', 't-alpha', 'admin@alpha.test.local', 'Admin Alpha', 'hash') \gset
SELECT out_tenant_id AS tb, out_user_id AS ub
  FROM signup_tenant('Beta SA', 't-beta', 'admin@beta.test.local', 'Admin Beta', 'hash') \gset

INSERT INTO organizations (tenant_id, name) VALUES (:'ta', 'ACME') RETURNING id AS org1 \gset

INSERT INTO users (email, name, password_hash) VALUES ('agente@alpha.test.local',   'Agente',    'h') RETURNING id AS ug  \gset
INSERT INTO users (email, name, password_hash) VALUES ('cliente1@alpha.test.local', 'Cliente 1', 'h') RETURNING id AS ur1 \gset
INSERT INTO users (email, name, password_hash) VALUES ('cliente2@alpha.test.local', 'Cliente 2', 'h') RETURNING id AS ur2 \gset
INSERT INTO memberships (tenant_id, user_id, role) VALUES (:'ta', :'ug', 'agent');
INSERT INTO memberships (tenant_id, user_id, role, organization_id) VALUES (:'ta', :'ur1', 'requester', :'org1');
INSERT INTO memberships (tenant_id, user_id, role) VALUES (:'ta', :'ur2', 'requester');

SELECT id AS cat_alpha FROM categories WHERE tenant_id = :'ta' LIMIT 1 \gset

-- ======================================================================
\warn '== 1. falha fechada e isolamento entre tenants =='
SET ROLE sd_app;
SELECT app_set_context(NULL, NULL, false);
SELECT tst.ok((SELECT count(*) FROM tenants) = 0,  'sem contexto: nenhum tenant visível');
SELECT tst.ok((SELECT count(*) FROM statuses) = 0, 'sem contexto: nenhum status visível');
SELECT tst.expect_error('SELECT password_hash FROM users', '42501', 'sd_app não lê password_hash');

SELECT app_set_context(:'ta', :'ua', false);
SELECT tst.ok((SELECT count(*) FROM tenants) = 1, 'admin alpha vê só o próprio tenant');
SELECT tst.ok((SELECT count(*) FROM statuses) = 6 AND (SELECT count(*) FROM priorities) = 4, 'defaults do workspace criados (6 status, 4 prioridades)');
SELECT tst.ok((SELECT count(*) FROM sla_policies) = 5, 'políticas de SLA criadas (4 prioridades + padrão)');

-- ======================================================================
\warn '== 2. cliente abre chamado =='
SELECT app_set_context(:'ta', :'ur1', false);
INSERT INTO tickets (tenant_id, subject, description, requester_id, category_id)
VALUES (:'ta', 'Impressora não funciona', 'Não imprime desde ontem', :'ur1', :'cat_alpha') RETURNING id AS t1 \gset
SELECT tst.ok((SELECT number FROM tickets WHERE id = :'t1') = 1, 'primeiro chamado do tenant recebe número 1');
SELECT tst.ok((SELECT s.name FROM tickets t JOIN statuses s ON s.id = t.status_id WHERE t.id = :'t1') = 'Novo', 'status inicial = Novo');
SELECT tst.ok((SELECT organization_id FROM tickets WHERE id = :'t1') = :'org1', 'organização herdada do solicitante');
SELECT tst.ok((SELECT queue_id FROM tickets WHERE id = :'t1') IS NOT NULL, 'fila definida pela categoria');

-- cliente tenta forçar prioridade/responsável: ignorado
INSERT INTO tickets (tenant_id, subject, requester_id, priority_id, assignee_id)
VALUES (:'ta', 'Tentando furar a fila', :'ur1', (SELECT id FROM priorities WHERE name = 'Urgente'), :'ug') RETURNING id AS t_forced \gset
SELECT tst.ok((SELECT p.name FROM tickets t JOIN priorities p ON p.id = t.priority_id WHERE t.id = :'t_forced') = 'Normal'
              AND (SELECT assignee_id FROM tickets WHERE id = :'t_forced') IS NULL,
              'cliente não consegue definir prioridade nem responsável');

SELECT tst.expect_error(format('INSERT INTO tickets (tenant_id, subject, requester_id) VALUES (%L, %L, %L)', :'ta', 'em nome de outro', :'ur2'),
                        '42501', 'cliente não abre chamado em nome de outro cliente (RLS)');

SELECT app_set_context(:'ta', :'ur2', false);
INSERT INTO tickets (tenant_id, subject, requester_id) VALUES (:'ta', 'Chamado do cliente 2', :'ur2') RETURNING id AS t2 \gset
SELECT tst.ok((SELECT count(*) FROM tickets) = 1, 'cliente 2 vê apenas o próprio chamado');
SELECT tst.ok((SELECT count(*) FROM ticket_events) = 0 AND (SELECT count(*) FROM sla_timers) = 0, 'cliente não vê auditoria nem cronômetros de SLA');
SELECT tst.expect_error('DELETE FROM tickets', '42501', 'ninguém apaga chamados (sem DELETE)');
SELECT tst.expect_error('UPDATE ticket_events SET event_type = ''x''', '42501', 'auditoria é somente-inserção');
WITH u AS (UPDATE tickets SET subject = 'alterado pelo cliente' WHERE id = :'t2' RETURNING 1)
SELECT tst.ok((SELECT count(*) FROM u) = 0, 'cliente não consegue atualizar chamados (0 linhas afetadas)');

-- ======================================================================
\warn '== 3. atendimento: SLA, primeira resposta, notas internas =='
SELECT app_set_context(:'ta', :'ug', false);
SELECT tst.ok((SELECT count(*) FROM tickets) = 3, 'agente vê todos os chamados do tenant');
SELECT tst.ok((SELECT count(*) FROM v_ticket_sla WHERE ticket_id = :'t1' AND state = 'running') = 2, 'dois cronômetros de SLA rodando');

UPDATE tickets SET assignee_id = :'ug', status_id = (SELECT id FROM statuses WHERE name = 'Em atendimento') WHERE id = :'t1';
SELECT tst.expect_error(format('UPDATE tickets SET assignee_id = %L WHERE id = %L', :'ur1', :'t1'), '23514', 'responsável precisa ser da equipe');

INSERT INTO ticket_messages (tenant_id, ticket_id, author_id, kind, body)
VALUES (:'ta', :'t1', :'ug', 'internal_note', 'Provável driver corrompido.');
INSERT INTO ticket_messages (tenant_id, ticket_id, author_id, kind, body)
VALUES (:'ta', :'t1', :'ug', 'public_reply', 'Olá! Já estamos verificando.');
SELECT tst.ok((SELECT first_response_at FROM tickets WHERE id = :'t1') IS NOT NULL, 'primeira resposta registrada');
SELECT tst.ok((SELECT state FROM v_ticket_sla WHERE ticket_id = :'t1' AND kind = 'first_response') = 'met', 'SLA de primeira resposta cumprido');

SELECT app_set_context(:'ta', :'ur1', false);
SELECT tst.ok((SELECT count(*) FROM ticket_messages WHERE ticket_id = :'t1') = 1, 'cliente vê só a resposta pública (nota interna oculta)');
SELECT tst.expect_error(format('INSERT INTO ticket_messages (tenant_id, ticket_id, author_id, kind, body) VALUES (%L,%L,%L,''internal_note'',''x'')', :'ta', :'t1', :'ur1'),
                        '42501', 'cliente não cria nota interna');
SELECT tst.expect_error(format('INSERT INTO ticket_messages (tenant_id, ticket_id, author_id, kind, body) VALUES (%L,%L,%L,''public_reply'',''x'')', :'ta', :'t2', :'ur1'),
                        '42501', 'cliente não responde chamado de outro cliente');

-- ======================================================================
\warn '== 4. pausa/retomada do SLA e reabertura pela resposta do cliente =='
SELECT app_set_context(:'ta', :'ug', false);
UPDATE tickets SET status_id = (SELECT id FROM statuses WHERE name = 'Aguardando cliente') WHERE id = :'t1';
SELECT tst.ok((SELECT state FROM v_ticket_sla WHERE ticket_id = :'t1' AND kind = 'resolution') = 'paused', 'status "Aguardando cliente" pausa o SLA');
SELECT due_at AS due_before FROM sla_timers WHERE ticket_id = :'t1' AND kind = 'resolution' \gset
SELECT pg_sleep(2);
UPDATE tickets SET status_id = (SELECT id FROM statuses WHERE name = 'Em atendimento') WHERE id = :'t1';
SELECT tst.ok((SELECT paused_seconds >= 2 AND due_at >= :'due_before'::timestamptz + interval '2 seconds' AND paused_at IS NULL
                 FROM sla_timers WHERE ticket_id = :'t1' AND kind = 'resolution'), 'retomada empurra o prazo pelo tempo pausado');

UPDATE tickets SET status_id = (SELECT id FROM statuses WHERE name = 'Aguardando cliente') WHERE id = :'t1';
SELECT app_set_context(:'ta', :'ur1', false);
INSERT INTO ticket_messages (tenant_id, ticket_id, author_id, kind, body)
VALUES (:'ta', :'t1', :'ur1', 'public_reply', 'Reiniciei e continua igual.');
SELECT tst.ok((SELECT s.name FROM tickets t JOIN statuses s ON s.id = t.status_id WHERE t.id = :'t1') = 'Novo',
              'resposta do cliente tira de "Aguardando cliente"');

-- ======================================================================
\warn '== 5. resolução, reabertura e mudança de prioridade =='
SELECT app_set_context(:'ta', :'ug', false);
SELECT due_at AS due_normal FROM sla_timers WHERE ticket_id = :'t1' AND kind = 'resolution' \gset
UPDATE tickets SET priority_id = (SELECT id FROM priorities WHERE name = 'Urgente') WHERE id = :'t1';
SELECT tst.ok((SELECT due_at FROM sla_timers WHERE ticket_id = :'t1' AND kind = 'resolution') < :'due_normal'::timestamptz,
              'prioridade Urgente recalcula prazo de resolução para mais cedo');

UPDATE tickets SET status_id = (SELECT id FROM statuses WHERE name = 'Resolvido') WHERE id = :'t1';
SELECT tst.ok((SELECT resolved_at IS NOT NULL FROM tickets WHERE id = :'t1')
              AND (SELECT count(*) FROM sla_timers WHERE ticket_id = :'t1' AND met_at IS NOT NULL) = 2, 'resolver registra data e encerra cronômetros');
UPDATE tickets SET status_id = (SELECT id FROM statuses WHERE name = 'Em atendimento') WHERE id = :'t1';
SELECT tst.ok((SELECT resolved_at IS NULL FROM tickets WHERE id = :'t1')
              AND (SELECT met_at IS NULL FROM sla_timers WHERE ticket_id = :'t1' AND kind = 'resolution')
              AND (SELECT met_at IS NOT NULL FROM sla_timers WHERE ticket_id = :'t1' AND kind = 'first_response'), 'reabrir reativa só o SLA de resolução');
SELECT tst.ok((SELECT count(*) FROM ticket_events WHERE ticket_id = :'t1' AND event_type = 'status_changed') >= 6, 'auditoria registra mudanças de status');

INSERT INTO time_entries (tenant_id, ticket_id, user_id, minutes, note) VALUES (:'ta', :'t1', :'ug', 45, 'Diagnóstico');
SELECT tst.ok((SELECT sum(minutes) FROM time_entries WHERE ticket_id = :'t1') = 45, 'apontamento de horas');
SELECT tst.expect_error(format('INSERT INTO time_entries (tenant_id, ticket_id, user_id, minutes) VALUES (%L,%L,%L,10)', :'ta', :'t1', :'ua'),
                        '42501', 'agente só aponta horas em seu próprio nome');

-- ======================================================================
\warn '== 6. isolamento entre tenants (alpha x beta) =='
SELECT app_set_context(:'tb', :'ub', false);
SELECT tst.ok((SELECT count(*) FROM tickets) = 0, 'admin beta não vê chamados do alpha');
SELECT tst.ok((SELECT count(*) FROM tickets WHERE id = :'t1') = 0, 'acesso direto por id também é bloqueado');
INSERT INTO tickets (tenant_id, subject, requester_id) VALUES (:'tb', 'Primeiro da Beta', :'ub') RETURNING id AS tb1 \gset
SELECT tst.ok((SELECT number FROM tickets WHERE id = :'tb1') = 1, 'numeração é independente por tenant');
SELECT tst.expect_error(format('INSERT INTO tickets (tenant_id, subject, requester_id) VALUES (%L, ''x'', %L)', :'ta', :'ua'),
                        '42501', 'não grava com tenant_id de outro tenant (RLS)');
SELECT tst.expect_error(format('INSERT INTO tickets (tenant_id, subject, requester_id) VALUES (%L, ''x'', %L)', :'tb', :'ur1'),
                        '23503', 'FK composta barra solicitante de outro tenant');
SELECT tst.expect_error(format('INSERT INTO tickets (tenant_id, subject, requester_id, category_id) VALUES (%L, ''x'', %L, %L)', :'tb', :'ub', :'cat_alpha'),
                        '23503', 'FK composta barra categoria de outro tenant');
WITH u AS (UPDATE tickets SET subject = 'hack' WHERE id = :'t1' RETURNING 1)
SELECT tst.ok((SELECT count(*) FROM u) = 0, 'UPDATE em chamado de outro tenant não afeta nenhuma linha');

-- ======================================================================
\warn '== 7. convites e autenticação =='
SELECT app_set_context(:'ta', :'ua', false);
INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by)
VALUES (:'ta', 'novo@alpha.test.local', 'requester', 'tok-abc', :'ua');
SELECT app_set_context(NULL, NULL, false);
SELECT out_user_id AS nu FROM accept_invitation('tok-abc', 'Novo Usuário', 'hash-novo') \gset
SELECT tst.ok((SELECT password_hash FROM auth_get_user_by_email('novo@alpha.test.local')) = 'hash-novo', 'auth_get_user_by_email devolve o hash para o login');
SELECT tst.ok((SELECT count(*) FROM auth_list_memberships(:'nu')) = 1, 'convite aceito cria membership');
SELECT tst.expect_error($$SELECT * FROM accept_invitation('tok-abc', 'X', 'h')$$, 'P0002', 'convite não pode ser reutilizado');
SELECT tst.expect_error($$SELECT * FROM signup_tenant('Dup', 't-dup', 'admin@alpha.test.local', 'X', 'h')$$, '23505', 'cadastro com e-mail existente é recusado');

-- ======================================================================
\warn '== 8. regras de plano (superusuário/worker) =='
RESET ROLE;
INSERT INTO users (email, name) VALUES ('agente2@alpha.test.local', 'Agente 2') RETURNING id AS ug2 \gset
INSERT INTO users (email, name) VALUES ('agente3@alpha.test.local', 'Agente 3') RETURNING id AS ug3 \gset
INSERT INTO memberships (tenant_id, user_id, role) VALUES (:'ta', :'ug2', 'agent');   -- 3º agente: ok (limite Starter = 3)
SELECT tst.expect_error(format('INSERT INTO memberships (tenant_id, user_id, role) VALUES (%L,%L,''agent'')', :'ta', :'ug3'),
                        '23514', 'limite de agentes do plano Starter (3)');

INSERT INTO plans (id, name, price_cents, max_tickets_per_month) VALUES ('qa-test', 'QA', 0, 2);
UPDATE tenants SET plan_id = 'qa-test' WHERE id = :'tb';
SET ROLE sd_app;
SELECT app_set_context(:'tb', :'ub', false);
INSERT INTO tickets (tenant_id, subject, requester_id) VALUES (:'tb', 'Segundo da Beta', :'ub');
SELECT tst.expect_error(format('INSERT INTO tickets (tenant_id, subject, requester_id) VALUES (%L, ''Terceiro'', %L)', :'tb', :'ub'),
                        '23514', 'cota mensal de chamados do plano');
RESET ROLE;
UPDATE tenants SET plan_id = 'starter', status = 'suspended' WHERE id = :'tb';
SET ROLE sd_app;
SELECT app_set_context(:'tb', :'ub', false);
SELECT tst.expect_error(format('INSERT INTO tickets (tenant_id, subject, requester_id) VALUES (%L, ''x'', %L)', :'tb', :'ub'),
                        '23514', 'tenant suspenso não abre chamados');
RESET ROLE;

-- ======================================================================
\warn '== 9. horário comercial =='
SELECT id AS bh FROM business_hours WHERE tenant_id = :'ta' \gset
SELECT tst.ok(sla_add_business_minutes(:'bh', '2026-10-30 17:00-03', 120) = '2026-11-02 09:00-03'::timestamptz, 'sex 17:00 + 2h úteis => seg 09:00');
SELECT tst.ok(sla_add_business_minutes(:'bh', '2026-10-31 10:00-03', 30)  = '2026-11-02 08:30-03'::timestamptz, 'sábado + 30min => seg 08:30');
SELECT tst.ok(sla_add_business_minutes(:'bh', '2026-11-02 11:30-03', 90)  = '2026-11-02 14:00-03'::timestamptz, 'pula o intervalo de almoço');
INSERT INTO business_holidays (tenant_id, business_hours_id, holiday_date, name) VALUES (:'ta', :'bh', '2026-11-02', 'Finados');
SELECT tst.ok(sla_add_business_minutes(:'bh', '2026-10-30 17:00-03', 120) = '2026-11-03 09:00-03'::timestamptz, 'feriado cadastrado é ignorado');
SELECT tst.ok(sla_add_business_minutes(NULL, '2026-10-30 17:00-03', 120)   = '2026-10-30 19:00-03'::timestamptz, 'sem horário comercial = 24x7');

-- ======================================================================
\warn '== 10. worker: estouro de SLA e outbox =='
UPDATE sla_timers SET due_at = now() - interval '1 hour' WHERE ticket_id = :'t2' AND kind = 'resolution';
SET ROLE sd_worker;
SELECT sla_mark_breaches() AS n \gset
SELECT tst.ok(:n >= 1, 'sla_mark_breaches marcou chamados vencidos');
SELECT tst.ok((SELECT count(*) FROM ticket_events WHERE ticket_id = :'t2' AND event_type = 'sla_breached') = 1, 'estouro registrado na auditoria');
SELECT tst.ok(sla_mark_breaches() = 0, 'segunda execução não duplica estouros já marcados');
SELECT tst.ok((SELECT count(*) FROM email_outbox WHERE tenant_id = :'ta' AND template = 'ticket_created') >= 3, 'outbox: confirmação de abertura enfileirada');
SELECT tst.ok((SELECT count(*) FROM email_outbox WHERE tenant_id = :'ta' AND template = 'ticket_reply') = 1, 'outbox: resposta da equipe enfileirada');
RESET ROLE;
SET ROLE sd_app;
SELECT app_set_context(:'ta', :'ua', false);
SELECT tst.expect_error('SELECT * FROM email_outbox', '42501', 'API não acessa a outbox');
SELECT tst.expect_error('SELECT sla_mark_breaches()', '42501', 'API não executa rotinas do worker');
RESET ROLE;

-- ======================================================================
\warn '== 11. sessões (refresh tokens) e recuperação de senha =='
SET ROLE sd_app;
SELECT app_set_context(NULL, NULL, false);
SELECT tst.expect_error('SELECT * FROM refresh_tokens', '42501', 'API não lê refresh_tokens diretamente');
SELECT tst.expect_error('SELECT * FROM password_resets', '42501', 'API não lê password_resets diretamente');

SELECT auth_issue_refresh(:'ua', :'ta', 'rt-1') AS fam \gset
SELECT tst.expect_error(format('SELECT auth_issue_refresh(%L, %L, ''rt-x'')', :'ua', :'tb'),
                        '42501', 'não emite sessão para workspace do qual o usuário não é membro');

SELECT * FROM auth_rotate_refresh('rt-1', 'rt-2') \gset r_
SELECT tst.ok(:'r_status' = 'ok' AND :'r_user_id' = :'ua' AND :'r_tenant_id' = :'ta' AND :'r_family_id' = :'fam',
              'rotação devolve usuário, workspace e a mesma família');
SELECT status AS st FROM auth_rotate_refresh('rt-1', 'rt-3') \gset
SELECT tst.ok(:'st' = 'reused', 'reuso de token já rotacionado é detectado');
SELECT status AS st FROM auth_rotate_refresh('rt-2', 'rt-4') \gset
SELECT tst.ok(:'st' <> 'ok', 'detecção de reuso revoga a sessão inteira (o token novo também morre)');
SELECT status AS st FROM auth_rotate_refresh('nao-existe', 'rt-5') \gset
SELECT tst.ok(:'st' = 'invalid', 'token desconhecido é inválido');

SELECT auth_issue_refresh(:'ua', :'ta', 'rt-exp', interval '-1 second') IS NOT NULL AS issued \gset
SELECT status AS st FROM auth_rotate_refresh('rt-exp', 'rt-6') \gset
SELECT tst.ok(:'st' = 'invalid', 'refresh token expirado é inválido');

SELECT auth_issue_refresh(:'ua', :'ta', 'rt-logout') IS NOT NULL AS issued \gset
SELECT auth_revoke_refresh('rt-logout');
SELECT status AS st FROM auth_rotate_refresh('rt-logout', 'rt-7') \gset
SELECT tst.ok(:'st' <> 'ok', 'logout revoga a sessão');

SELECT auth_issue_refresh(:'ua', :'ta', 'rt-a') IS NOT NULL AS issued \gset
SELECT auth_issue_refresh(:'ua', NULL,  'rt-b') IS NOT NULL AS issued \gset
SELECT tst.ok(auth_revoke_all_refresh(:'ua') >= 2, 'sair de todos os dispositivos revoga todas as sessões');
SELECT status AS st FROM auth_rotate_refresh('rt-b', 'rt-8') \gset
SELECT tst.ok(:'st' <> 'ok', 'sessão sem workspace também foi revogada');

-- usuário desativado perde a sessão no próximo refresh
SELECT auth_issue_refresh(:'ug', :'ta', 'rt-ug') IS NOT NULL AS issued \gset
RESET ROLE;
UPDATE users SET disabled_at = now() WHERE id = :'ug';
SET ROLE sd_app;
SELECT status AS st FROM auth_rotate_refresh('rt-ug', 'rt-9') \gset
SELECT tst.ok(:'st' = 'invalid', 'usuário desativado não renova a sessão');
SELECT tst.expect_error(format('SELECT auth_issue_refresh(%L, %L, ''rt-ug2'')', :'ug', :'ta'), '42501', 'usuário desativado não abre sessão');
RESET ROLE;
UPDATE users SET disabled_at = NULL WHERE id = :'ug';

-- recuperação de senha
SET ROLE sd_app;
SELECT count(*) AS n FROM auth_request_password_reset('ninguem@alpha.test.local', 'pr-0') \gset
SELECT tst.ok(:n = 0, 'e-mail desconhecido não devolve linha (a API responde igual nos dois casos)');
SELECT count(*) AS n FROM auth_request_password_reset('admin@alpha.test.local', 'pr-1') \gset
SELECT tst.ok(:n = 1, 'pedido de reset para e-mail existente');
SELECT count(*) AS n FROM auth_request_password_reset('ADMIN@alpha.test.local', 'pr-2') \gset
SELECT tst.ok(:n = 1, 'e-mail é case-insensitive');
SELECT tst.ok(NOT auth_reset_password('pr-1', 'h-x'), 'novo pedido invalida o anterior');
SELECT auth_issue_refresh(:'ua', :'ta', 'rt-pre-reset') IS NOT NULL AS issued \gset
SELECT tst.ok(auth_reset_password('pr-2', 'hash-novo'), 'token válido troca a senha');
SELECT tst.ok((SELECT password_hash FROM auth_get_user_by_email('admin@alpha.test.local')) = 'hash-novo', 'nova senha gravada');
SELECT tst.ok(NOT auth_reset_password('pr-2', 'h-y'), 'token de reset é de uso único');
SELECT status AS st FROM auth_rotate_refresh('rt-pre-reset', 'rt-10') \gset
SELECT tst.ok(:'st' <> 'ok', 'trocar a senha revoga as sessões abertas');
RESET ROLE;
INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (:'ua', 'pr-old', now() - interval '1 minute');
SET ROLE sd_app;
SELECT tst.ok(NOT auth_reset_password('pr-old', 'h-z'), 'token de reset expirado é recusado');

-- limpeza periódica pelo worker
RESET ROLE;
INSERT INTO refresh_tokens (family_id, user_id, token_hash, expires_at)
VALUES (gen_random_uuid(), :'ua', 'rt-velho', now() - interval '10 days');
SET ROLE sd_app;
SELECT tst.expect_error('SELECT auth_purge_expired()', '42501', 'API não executa a limpeza de tokens');
RESET ROLE;
SET ROLE sd_worker;
SELECT auth_purge_expired() AS n \gset
SELECT tst.ok(:n >= 1, 'worker remove tokens expirados');
RESET ROLE;

-- ======================================================================
\warn '== 12. macros, visões salvas e relatórios =='
SET ROLE sd_app;
SELECT app_set_context(:'ta', :'ug', false);
INSERT INTO macros (tenant_id, owner_id, name, body, shared)
VALUES (:'ta', :'ug', 'Saudação', 'Olá {{solicitante.nome}}!', true) RETURNING id AS m1 \gset
INSERT INTO macros (tenant_id, owner_id, name, body, shared)
VALUES (:'ta', :'ug', 'Privada', 'texto', false);
INSERT INTO saved_views (tenant_id, owner_id, name, filters)
VALUES (:'ta', :'ug', 'Meus abertos', '{"assignee":"me"}');
SELECT tst.expect_error(format('INSERT INTO macros (tenant_id, owner_id, name, body) VALUES (%L,%L,''Forjada'',''x'')', :'ta', :'ua'),
                        '42501', 'agente não cria macro em nome de outra pessoa');
SELECT tst.expect_error(format('INSERT INTO macros (tenant_id, owner_id, name, body) VALUES (%L,%L,''saudação'',''x'')', :'ta', :'ug'),
                        '23505', 'nome de macro é único por dono (sem diferenciar maiúsculas)');

SELECT app_set_context(:'ta', :'ug2', false);
SELECT tst.ok((SELECT count(*) FROM macros) = 1, 'outro agente vê só a macro compartilhada');
SELECT tst.ok((SELECT count(*) FROM saved_views) = 0, 'visão não compartilhada fica privada');
WITH u AS (UPDATE macros SET body = 'alterada' WHERE id = :'m1' RETURNING 1)
SELECT tst.ok((SELECT count(*) FROM u) = 0, 'outro agente não edita macro alheia');

SELECT app_set_context(:'ta', :'ua', false);
SELECT tst.ok((SELECT count(*) FROM macros) = 2, 'admin vê todas as macros');
SELECT app_set_context(:'ta', :'ur1', false);
SELECT tst.ok((SELECT count(*) FROM macros) = 0 AND (SELECT count(*) FROM saved_views) = 0, 'cliente não vê macros nem visões');
SELECT tst.expect_error(format('INSERT INTO macros (tenant_id, owner_id, name, body) VALUES (%L,%L,''x'',''x'')', :'ta', :'ur1'),
                        '42501', 'cliente não cria macro');

-- relatórios
SELECT app_set_context(:'ta', :'ug', false);
SELECT tst.ok((SELECT worked_on FROM time_entries WHERE ticket_id = :'t1' LIMIT 1)
              = (now() AT TIME ZONE 'America/Sao_Paulo')::date, 'apontamento usa o dia do fuso do tenant');
SELECT report_overview() AS rep \gset
SELECT tst.ok((:'rep'::jsonb->'totals'->>'created')::int = (SELECT count(*) FROM tickets), 'relatório: total criado = chamados do tenant');
SELECT tst.ok((SELECT sum((x->>'count')::int) FROM jsonb_array_elements(:'rep'::jsonb->'open_by_status') x) = (SELECT count(*) FROM tickets),
              'relatório: soma por status = total de chamados');
SELECT tst.ok((SELECT sum((x->>'created')::int) FROM jsonb_array_elements(:'rep'::jsonb->'daily') x) = (:'rep'::jsonb->'totals'->>'created')::int,
              'relatório: série diária soma o total criado');
SELECT tst.ok(jsonb_array_length(:'rep'::jsonb->'daily') BETWEEN 30 AND 32, 'relatório: série diária cobre o período');
SELECT tst.ok((:'rep'::jsonb->'totals'->>'time_logged_minutes')::int = 45, 'relatório: horas apontadas (45 min)');
SELECT tst.ok((SELECT (x->>'minutes_logged')::int FROM jsonb_array_elements(:'rep'::jsonb->'by_agent') x WHERE x->>'name' = 'Agente') = 45,
              'relatório: horas por agente');
SELECT tst.ok((:'rep'::jsonb->'totals'->>'sla_breached_open')::int >= 1, 'relatório: conta SLA estourado em chamados abertos');
SELECT tst.ok((:'rep'::jsonb->>'avg_first_response_minutes')::numeric >= 0, 'relatório: tempo médio de primeira resposta');
SELECT tst.ok(:'rep'::jsonb->>'sla_compliance_pct' IS NULL OR (:'rep'::jsonb->>'sla_compliance_pct')::numeric BETWEEN 0 AND 100,
              'relatório: % de SLA cumprido entre 0 e 100');
SELECT tst.ok(jsonb_array_length(:'rep'::jsonb->'by_priority') = 4, 'relatório: distribuição por prioridade');

SELECT app_set_context(:'tb', :'ub', false);
SELECT report_overview() AS rep_b \gset
SELECT tst.ok((:'rep_b'::jsonb->'totals'->>'created')::int = (SELECT count(*) FROM tickets)
              AND (:'rep_b'::jsonb->'totals'->>'created')::int < (:'rep'::jsonb->'totals'->>'created')::int,
              'relatório do tenant B só enxerga dados do tenant B');
SELECT app_set_context(:'ta', :'ur1', false);
SELECT tst.expect_error('SELECT report_overview()', '42501', 'cliente não acessa relatórios');
SELECT app_set_context(:'ta', :'ua', false);
SELECT tst.expect_error('SELECT report_overview(now(), now() - interval ''1 day'')', '22023', 'período invertido é recusado');
RESET ROLE;

-- ======================================================================
\warn '== 13. e-mails de sistema: convite e redefinição de senha =='
SET ROLE sd_app;
SELECT app_set_context(:'ta', :'ua', false);
INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by)
VALUES (:'ta', 'convite13@alpha.test.local', 'agent', encode(digest('tok-convite-13', 'sha256'), 'hex'), :'ua')
RETURNING id AS inv13 \gset
SELECT tst.ok(enqueue_invitation_email(:'inv13', 'tok-convite-13') > 0, 'admin enfileira e-mail do convite com o token certo');
SELECT tst.expect_error(format('SELECT enqueue_invitation_email(%L, ''outro-token'')', :'inv13'),
                        'P0002', 'token que não bate com o hash não enfileira nada');
SELECT app_set_context(:'ta', :'ug', false);
SELECT tst.expect_error(format('SELECT enqueue_invitation_email(%L, ''tok-convite-13'')', :'inv13'),
                        '42501', 'agente não enfileira convite');
SELECT app_set_context(:'tb', :'ub', false);
SELECT tst.expect_error(format('SELECT enqueue_invitation_email(%L, ''tok-convite-13'')', :'inv13'),
                        'P0002', 'admin de outro tenant não enfileira convite alheio');
SELECT tst.expect_error('INSERT INTO email_outbox (to_email, template) VALUES (''x@x'', ''x'')',
                        '42501', 'sd_app continua sem INSERT direto na outbox');

SELECT app_set_context(NULL, NULL, false);
SELECT count(*) AS n13 FROM auth_request_password_reset('cliente1@alpha.test.local', encode(digest('tok-reset-13', 'sha256'), 'hex')) \gset
SELECT tst.ok(:n13 = 1, 'pedido de reset criado');
SELECT tst.ok(enqueue_password_reset_email('tok-reset-13'), 'e-mail de reset enfileirado (sem tenant)');
SELECT tst.ok(NOT enqueue_password_reset_email('tok-reset-13'), 'o mesmo pedido não é enfileirado duas vezes');
SELECT tst.ok(NOT enqueue_password_reset_email('token-inventado'), 'token inventado não enfileira');
RESET ROLE;
SELECT tst.ok((SELECT count(*) FROM email_outbox WHERE template = 'invitation' AND to_email = 'convite13@alpha.test.local'
                AND payload->>'token' = 'tok-convite-13' AND tenant_id = :'ta') = 1, 'outbox: convite com link e tenant');
SELECT tst.ok((SELECT count(*) FROM email_outbox WHERE template = 'password_reset' AND to_email = 'cliente1@alpha.test.local'
                AND tenant_id IS NULL) = 1, 'outbox: reset sem tenant');
SET ROLE sd_worker;
SELECT tst.ok((SELECT count(*) FROM email_outbox WHERE template IN ('invitation', 'password_reset')) >= 2,
              'worker enxerga os e-mails de sistema');
RESET ROLE;
DELETE FROM email_outbox WHERE template = 'password_reset' AND to_email LIKE '%.test.local';

-- ---------- limpeza ----------
SELECT delete_tenant(id) FROM tenants WHERE slug IN ('t-alpha', 't-beta');
DELETE FROM users   WHERE email LIKE '%.test.local';
DELETE FROM plans   WHERE id = 'qa-test';
DROP SCHEMA tst CASCADE;
\warn '== TODOS OS TESTES PASSARAM =='
