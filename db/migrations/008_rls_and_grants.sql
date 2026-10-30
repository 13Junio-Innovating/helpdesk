-- 008: Row-Level Security + permissões por role
--
-- Modelo: a API conecta como sd_app e, a cada transação, chama
--   SELECT app_set_context(<tenant_id>, <user_id>);
-- Sem contexto => app_tenant_id() é NULL => nenhuma linha é visível (falha fechada).
-- O dono (sd_owner) ignora RLS de propósito: só migrations e funções SECURITY DEFINER usam esse papel.

-- app_role() lê memberships, que tem RLS que usa app_role(): precisa ser DEFINER para não recursar.
CREATE OR REPLACE FUNCTION app_role() RETURNS member_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.role FROM memberships m
   WHERE m.tenant_id = app_tenant_id() AND m.user_id = app_user_id() AND m.active
$$;

-- ---------- habilita RLS em TODAS as tabelas de dados ----------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables
            WHERE schemaname = 'public' AND tablename NOT IN ('plans', 'schema_migrations')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;
-- tenant_counters, billing_events e email_outbox ficam SEM policy: só sd_owner/sd_worker acessam.

-- ---------- tenants / assinatura / usuários ----------
CREATE POLICY tenants_select ON tenants FOR SELECT
  USING (id = app_tenant_id());
CREATE POLICY tenants_update ON tenants FOR UPDATE
  USING (id = app_tenant_id() AND (SELECT app_is_admin()))
  WITH CHECK (id = app_tenant_id());

CREATE POLICY subscriptions_select ON subscriptions FOR SELECT
  USING (tenant_id = app_tenant_id() AND (SELECT app_is_admin()));

-- usuário vê a si mesmo e quem tem membership visível no tenant corrente
CREATE POLICY users_select ON users FOR SELECT
  USING (id = app_user_id()
         OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id));
CREATE POLICY users_update_self ON users FOR UPDATE
  USING (id = app_user_id()) WITH CHECK (id = app_user_id());

-- ---------- memberships / organizações / convites ----------
CREATE POLICY memberships_select ON memberships FOR SELECT
  USING (tenant_id = app_tenant_id()
         AND ((SELECT app_is_staff()) OR user_id = app_user_id() OR role IN ('admin', 'agent')));
CREATE POLICY memberships_update ON memberships FOR UPDATE
  USING (tenant_id = app_tenant_id() AND (SELECT app_is_admin()))
  WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY organizations_select ON organizations FOR SELECT
  USING (tenant_id = app_tenant_id() AND (SELECT app_is_staff()));
CREATE POLICY organizations_write ON organizations FOR ALL
  USING (tenant_id = app_tenant_id() AND (SELECT app_is_staff()))
  WITH CHECK (tenant_id = app_tenant_id() AND (SELECT app_is_staff()));

CREATE POLICY invitations_admin ON invitations FOR ALL
  USING (tenant_id = app_tenant_id() AND (SELECT app_is_admin()))
  WITH CHECK (tenant_id = app_tenant_id() AND (SELECT app_is_admin()));

-- ---------- catálogo: todos leem, só admin escreve ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['queues', 'categories', 'priorities', 'statuses'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (tenant_id = app_tenant_id())', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL
                      USING (tenant_id = app_tenant_id() AND (SELECT app_is_admin()))
                      WITH CHECK (tenant_id = app_tenant_id() AND (SELECT app_is_admin()))', t || '_admin', t);
  END LOOP;

  -- configuração interna: equipe lê, admin escreve
  FOREACH t IN ARRAY ARRAY['queue_members', 'business_hours', 'business_hour_slots',
                           'business_holidays', 'sla_policies', 'automation_rules'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT
                      USING (tenant_id = app_tenant_id() AND (SELECT app_is_staff()))', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL
                      USING (tenant_id = app_tenant_id() AND (SELECT app_is_admin()))
                      WITH CHECK (tenant_id = app_tenant_id() AND (SELECT app_is_admin()))', t || '_admin', t);
  END LOOP;
END $$;

-- ---------- chamados ----------
-- Equipe vê tudo do tenant; cliente vê somente os chamados que abriu.
CREATE POLICY tickets_select ON tickets FOR SELECT
  USING (tenant_id = app_tenant_id()
         AND ((SELECT app_is_staff()) OR requester_id = app_user_id()));
CREATE POLICY tickets_insert ON tickets FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id()
              AND ((SELECT app_is_staff()) OR requester_id = app_user_id()));
CREATE POLICY tickets_update ON tickets FOR UPDATE
  USING (tenant_id = app_tenant_id() AND (SELECT app_is_staff()))
  WITH CHECK (tenant_id = app_tenant_id() AND (SELECT app_is_staff()));

-- Mensagens: cliente nunca vê nota interna; só escreve resposta pública em chamado seu.
CREATE POLICY messages_select ON ticket_messages FOR SELECT
  USING (tenant_id = app_tenant_id()
         AND ((SELECT app_is_staff())
              OR (kind <> 'internal_note'
                  AND EXISTS (SELECT 1 FROM tickets t
                               WHERE t.tenant_id = ticket_messages.tenant_id AND t.id = ticket_messages.ticket_id))));
CREATE POLICY messages_insert ON ticket_messages FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id()
              AND author_id = app_user_id()
              AND ((SELECT app_is_staff())
                   OR (kind = 'public_reply'
                       AND EXISTS (SELECT 1 FROM tickets t
                                    WHERE t.tenant_id = ticket_messages.tenant_id AND t.id = ticket_messages.ticket_id))));

CREATE POLICY attachments_select ON attachments FOR SELECT
  USING (tenant_id = app_tenant_id()
         AND ((SELECT app_is_staff())
              OR (EXISTS (SELECT 1 FROM tickets t
                           WHERE t.tenant_id = attachments.tenant_id AND t.id = attachments.ticket_id)
                  AND (message_id IS NULL
                       OR EXISTS (SELECT 1 FROM ticket_messages m
                                   WHERE m.tenant_id = attachments.tenant_id AND m.id = attachments.message_id)))));
CREATE POLICY attachments_insert ON attachments FOR INSERT
  WITH CHECK (tenant_id = app_tenant_id()
              AND uploaded_by = app_user_id()
              AND EXISTS (SELECT 1 FROM tickets t
                           WHERE t.tenant_id = attachments.tenant_id AND t.id = attachments.ticket_id)
              AND (message_id IS NULL
                   OR EXISTS (SELECT 1 FROM ticket_messages m
                               WHERE m.tenant_id = attachments.tenant_id AND m.id = attachments.message_id)));
CREATE POLICY attachments_delete ON attachments FOR DELETE
  USING (tenant_id = app_tenant_id() AND ((SELECT app_is_staff()) OR uploaded_by = app_user_id()));

CREATE POLICY events_select ON ticket_events FOR SELECT
  USING (tenant_id = app_tenant_id() AND (SELECT app_is_staff()));

CREATE POLICY sla_timers_select ON sla_timers FOR SELECT
  USING (tenant_id = app_tenant_id() AND (SELECT app_is_staff()));

CREATE POLICY time_entries_select ON time_entries FOR SELECT
  USING (tenant_id = app_tenant_id() AND (SELECT app_is_staff()));
CREATE POLICY time_entries_write ON time_entries FOR ALL
  USING (tenant_id = app_tenant_id() AND (SELECT app_is_staff()))
  WITH CHECK (tenant_id = app_tenant_id() AND (SELECT app_is_staff()) AND user_id = app_user_id());

-- ---------- base de conhecimento ----------
CREATE POLICY kb_select ON kb_articles FOR SELECT
  USING (tenant_id = app_tenant_id()
         AND ((SELECT app_is_staff()) OR (status = 'published' AND visibility = 'portal')));
CREATE POLICY kb_write ON kb_articles FOR ALL
  USING (tenant_id = app_tenant_id() AND (SELECT app_is_staff()))
  WITH CHECK (tenant_id = app_tenant_id() AND (SELECT app_is_staff()));

-- ======================================================================
-- Permissões (GRANT)
-- ======================================================================
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
-- só nas funções do próprio projeto (as das extensões pertencem ao superusuário)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', r.sig);
  END LOOP;
END $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ---------- sd_app (API) ----------
GRANT SELECT ON plans TO sd_app;
GRANT SELECT ON tenants, subscriptions, organizations, memberships, invitations,
                queues, queue_members, categories, priorities, statuses,
                business_hours, business_hour_slots, business_holidays, sla_policies,
                tickets, ticket_messages, attachments, ticket_events, time_entries, sla_timers,
                automation_rules, kb_articles, v_ticket_sla TO sd_app;
GRANT SELECT (id, email, name, locale, avatar_url, last_login_at, disabled_at, created_at, updated_at)
  ON users TO sd_app;                                   -- password_hash NUNCA é legível pela API

GRANT UPDATE (name, timezone) ON tenants TO sd_app;
GRANT UPDATE (name, locale, avatar_url) ON users TO sd_app;
GRANT UPDATE (role, organization_id, phone, job_title, active) ON memberships TO sd_app;

GRANT INSERT, UPDATE, DELETE ON organizations, invitations,
                queues, queue_members, categories, priorities, statuses,
                business_hours, business_hour_slots, business_holidays, sla_policies,
                automation_rules, kb_articles, time_entries TO sd_app;

GRANT INSERT ON tickets, ticket_messages, attachments TO sd_app;
GRANT UPDATE (subject, description, assignee_id, queue_id, category_id, priority_id,
              status_id, organization_id, tags, custom_fields) ON tickets TO sd_app;
GRANT DELETE ON attachments TO sd_app;

GRANT EXECUTE ON FUNCTION app_tenant_id(), app_user_id(), app_set_context(uuid, uuid, boolean),
                          app_role(), app_is_staff(), app_is_admin() TO sd_app, sd_worker;
GRANT EXECUTE ON FUNCTION signup_tenant(text, text, citext, text, text),
                          create_tenant_for_user(uuid, text, text),
                          auth_get_user_by_email(citext), auth_list_memberships(uuid),
                          auth_touch_login(uuid), auth_set_password(uuid, text),
                          tenant_by_slug(citext), accept_invitation(text, text, text) TO sd_app;

-- ---------- sd_worker (jobs, webhooks, e-mail) — BYPASSRLS, escopo mínimo ----------
GRANT SELECT ON ALL TABLES IN SCHEMA public TO sd_worker;
GRANT INSERT, UPDATE ON email_outbox, billing_events, subscriptions, tickets,
                        ticket_messages, ticket_events TO sd_worker;
GRANT UPDATE ON tenants TO sd_worker;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO sd_worker;
GRANT EXECUTE ON FUNCTION sla_mark_breaches() TO sd_worker;
