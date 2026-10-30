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
SELECT sla_mark_breaches() AS n2 \gset
SELECT tst.ok((SELECT count(*) FROM ticket_events WHERE ticket_id = :'t2' AND event_type = 'sla_breached') = 1, 'segunda execução não duplica');
SELECT tst.ok((SELECT count(*) FROM email_outbox WHERE tenant_id = :'ta' AND template = 'ticket_created') >= 3, 'outbox: confirmação de abertura enfileirada');
SELECT tst.ok((SELECT count(*) FROM email_outbox WHERE tenant_id = :'ta' AND template = 'ticket_reply') = 1, 'outbox: resposta da equipe enfileirada');
RESET ROLE;
SET ROLE sd_app;
SELECT app_set_context(:'ta', :'ua', false);
SELECT tst.expect_error('SELECT * FROM email_outbox', '42501', 'API não acessa a outbox');
SELECT tst.expect_error('SELECT sla_mark_breaches()', '42501', 'API não executa rotinas do worker');
RESET ROLE;

-- ======================================================================
\warn '== 11. sessões (refresh com rotação) e redefinição de senha =='
SET ROLE sd_app;
SELECT app_set_context(NULL, NULL, false);
SELECT tst.expect_error('SELECT * FROM auth_refresh_tokens', '42501', 'API não lê refresh tokens diretamente');
SELECT tst.expect_error('SELECT * FROM password_reset_tokens', '42501', 'API não lê tokens de reset diretamente');
SELECT tst.ok(auth_can_access(:'ua', :'ta') AND NOT auth_can_access(:'ua', :'tb'), 'auth_can_access respeita membership');
SELECT auth_session_create(:'ua', :'ta', 'rt-1', interval '30 days') AS fam \gset
SELECT tst.expect_error(format('SELECT auth_session_create(%L, %L, ''rt-x'', interval ''1 day'')', :'ua', :'tb'),
                        '28000', 'não cria sessão em tenant sem membership');
SELECT tst.ok((SELECT status = 'ok' AND user_id = :'ua' AND tenant_id = :'ta' FROM auth_session_rotate('rt-1', 'rt-2', interval '30 days')),
              'rotação devolve usuário e tenant');
SELECT tst.ok((SELECT status FROM auth_session_rotate('rt-2', 'rt-3', interval '30 days')) = 'ok', 'token novo rotaciona de novo');
SELECT tst.ok((SELECT status FROM auth_session_rotate('rt-1', 'rt-x1', interval '30 days')) = 'reused', 'reapresentar token antigo é detectado como reuso');
SELECT tst.ok((SELECT status FROM auth_session_rotate('rt-3', 'rt-4', interval '30 days')) = 'invalid', 'reuso revoga a família inteira');
SELECT tst.ok((SELECT status FROM auth_session_rotate('nao-existe', 'rt-5', interval '30 days')) = 'invalid', 'token desconhecido é inválido');

SELECT auth_session_create(:'ug', :'ta', 'rt-ag', interval '30 days') AS fam2 \gset
SELECT auth_session_revoke('rt-ag');
SELECT tst.ok((SELECT status FROM auth_session_rotate('rt-ag', 'rt-ag2', interval '30 days')) = 'invalid', 'logout revoga a sessão');

SELECT auth_session_create(:'ug', :'ta', 'rt-ag3', interval '30 days') AS fam3 \gset
RESET ROLE;
UPDATE users SET disabled_at = now() WHERE id = :'ug';
SET ROLE sd_app;
SELECT tst.ok((SELECT status FROM auth_session_rotate('rt-ag3', 'rt-ag4', interval '30 days')) = 'invalid', 'usuário desativado não renova sessão');
RESET ROLE;
UPDATE users SET disabled_at = NULL WHERE id = :'ug';
SET ROLE sd_app;

SELECT tst.ok(NOT auth_reset_create('ninguem@alpha.test.local', 'rs-0', 'raw-0', interval '1 hour'), 'reset para e-mail inexistente não gera token');
SELECT tst.ok(auth_reset_create('cliente1@alpha.test.local', 'rs-1', 'raw-1', interval '1 hour'), 'reset gera token');
SELECT tst.ok(auth_reset_create('cliente1@alpha.test.local', 'rs-2', 'raw-2', interval '1 hour'), 'novo pedido de reset');
SELECT tst.expect_error($$SELECT auth_reset_consume('rs-1', 'novo-hash')$$, 'P0002', 'pedido anterior é invalidado pelo novo');
SELECT auth_session_create(:'ur1', :'ta', 'rt-c1', interval '30 days') AS fam4 \gset
SELECT tst.ok(auth_reset_consume('rs-2', 'novo-hash') = :'ur1', 'reset troca a senha');
SELECT tst.expect_error($$SELECT auth_reset_consume('rs-2', 'outro')$$, 'P0002', 'token de reset é de uso único');
SELECT tst.ok((SELECT password_hash FROM auth_get_user_by_email('cliente1@alpha.test.local')) = 'novo-hash', 'nova senha gravada');
SELECT tst.ok((SELECT status FROM auth_session_rotate('rt-c1', 'rt-c2', interval '30 days')) = 'invalid', 'reset derruba sessões abertas');
RESET ROLE;
SELECT tst.ok((SELECT count(*) FROM email_outbox WHERE template = 'password_reset' AND to_email = 'cliente1@alpha.test.local' AND tenant_id IS NULL) = 2,
              'e-mail de reset enfileirado (sem tenant)');
DELETE FROM email_outbox WHERE template = 'password_reset' AND to_email LIKE '%.test.local';

-- ======================================================================
\warn '== 12. e-mail de convite (011) =='
SET ROLE sd_app;
SELECT app_set_context(:'ta', :'ua', false);
INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by)
VALUES (:'ta', 'convidado@alpha.test.local', 'requester', 'tok-conv', :'ua') RETURNING id AS inv1 \gset
SELECT enqueue_invitation_email(:'inv1', 'raw-conv');
SELECT app_set_context(:'ta', :'ug', false);
SELECT tst.expect_error(format('SELECT enqueue_invitation_email(%L, ''x'')', :'inv1'), '42501', 'agente não enfileira convite');
SELECT app_set_context(:'tb', :'ub', false);
SELECT tst.expect_error(format('SELECT enqueue_invitation_email(%L, ''x'')', :'inv1'), 'P0002', 'admin de outro tenant não usa convite alheio');
SELECT app_set_context(NULL, NULL, false);
SELECT out_user_id AS conv FROM accept_invitation('tok-conv', 'Convidado', 'h') \gset
SELECT app_set_context(:'ta', :'ua', false);
SELECT tst.expect_error(format('SELECT enqueue_invitation_email(%L, ''x'')', :'inv1'), 'P0002', 'convite já aceito não gera e-mail');
RESET ROLE;
SELECT tst.ok((SELECT count(*) FROM email_outbox WHERE template = 'invitation' AND to_email = 'convidado@alpha.test.local'
                 AND payload->>'token' = 'raw-conv' AND payload->>'tenant_name' = 'Alpha Ltda') = 1, 'convite enfileirado com dados do workspace');

-- ======================================================================
\warn '== 13. estado do worker (012) =='
SET ROLE sd_worker;
SELECT id AS ev1 FROM ticket_events WHERE ticket_id = :'t1' ORDER BY id LIMIT 1 \gset
INSERT INTO automation_runs (event_id, tenant_id, rules_matched) VALUES (:ev1, :'ta', 1);
SELECT tst.expect_error(format('INSERT INTO automation_runs (event_id, tenant_id) VALUES (%s, %L)', :ev1, :'ta'), '23505', 'evento só é processado uma vez');
WITH ins AS (INSERT INTO automation_runs (event_id, tenant_id) VALUES (:ev1, :'ta') ON CONFLICT DO NOTHING RETURNING 1)
SELECT tst.ok((SELECT count(*) FROM ins) = 0, 'ON CONFLICT permite reivindicar sem erro');
SELECT id AS tm1 FROM sla_timers WHERE ticket_id = :'t2' LIMIT 1 \gset
INSERT INTO sla_alerts (timer_id, tenant_id) VALUES (:'tm1', :'ta');
WITH ins AS (INSERT INTO sla_alerts (timer_id, tenant_id) VALUES (:'tm1', :'ta') ON CONFLICT DO NOTHING RETURNING 1)
SELECT tst.ok((SELECT count(*) FROM ins) = 0, 'alerta de SLA registrado uma única vez por cronômetro');
RESET ROLE;
SET ROLE sd_app;
SELECT app_set_context(:'ta', :'ua', false);
SELECT tst.expect_error('SELECT * FROM automation_runs', '42501', 'API não lê o estado do worker');
SELECT tst.expect_error('SELECT * FROM sla_alerts', '42501', 'API não lê alertas de SLA');
RESET ROLE;

-- ---------- limpeza ----------
SELECT delete_tenant(id) FROM tenants WHERE slug IN ('t-alpha', 't-beta');
DELETE FROM users   WHERE email LIKE '%.test.local';
DELETE FROM plans   WHERE id = 'qa-test';
DROP SCHEMA tst CASCADE;
\warn '== TODOS OS TESTES PASSARAM =='
