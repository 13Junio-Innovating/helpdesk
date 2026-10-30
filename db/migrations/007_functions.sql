-- 007: funções de negócio (provisionamento, autenticação, convites, SLA)
-- Todas SECURITY DEFINER com search_path fixo. O EXECUTE é concedido em 008.

-- ---------- dados iniciais de um workspace novo ----------
CREATE FUNCTION seed_tenant_defaults(p_tenant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_bh uuid;
BEGIN
  INSERT INTO statuses (tenant_id, name, kind, sla_pauses, is_default, position, color) VALUES
    (p_tenant, 'Novo',               'open',     false, true,  1, '#2563eb'),
    (p_tenant, 'Em atendimento',     'open',     false, false, 2, '#7c3aed'),
    (p_tenant, 'Aguardando cliente', 'pending',  true,  false, 3, '#d97706'),
    (p_tenant, 'Em espera',          'on_hold',  true,  false, 4, '#64748b'),
    (p_tenant, 'Resolvido',          'resolved', false, false, 5, '#16a34a'),
    (p_tenant, 'Fechado',            'closed',   false, false, 6, '#475569');

  INSERT INTO priorities (tenant_id, name, level, color, is_default) VALUES
    (p_tenant, 'Baixa',   1, '#64748b', false),
    (p_tenant, 'Normal',  2, '#2563eb', true),
    (p_tenant, 'Alta',    3, '#d97706', false),
    (p_tenant, 'Urgente', 4, '#dc2626', false);

  INSERT INTO queues (tenant_id, name) VALUES (p_tenant, 'Suporte');

  INSERT INTO categories (tenant_id, name, default_queue_id)
  SELECT p_tenant, c.name, (SELECT id FROM queues WHERE tenant_id = p_tenant AND name = 'Suporte')
    FROM (VALUES ('Dúvida'), ('Incidente'), ('Solicitação')) AS c(name);

  INSERT INTO business_hours (tenant_id, name)
  VALUES (p_tenant, 'Horário comercial') RETURNING id INTO v_bh;

  INSERT INTO business_hour_slots (tenant_id, business_hours_id, weekday, start_time, end_time)
  SELECT p_tenant, v_bh, d, s.st, s.et
    FROM generate_series(1, 5) AS d,
         (VALUES ('08:00'::time, '12:00'::time), ('13:00'::time, '18:00'::time)) AS s(st, et);

  -- minutos ÚTEIS (horário comercial)
  INSERT INTO sla_policies (tenant_id, name, priority_id, first_response_minutes, resolution_minutes, business_hours_id)
  SELECT p_tenant, 'SLA ' || pr.name, pr.id, v.fr, v.res, v_bh
    FROM priorities pr
    JOIN (VALUES ('Baixa', 480, 2880), ('Normal', 240, 1440), ('Alta', 120, 480), ('Urgente', 30, 240))
         AS v(name, fr, res) ON v.name = pr.name
   WHERE pr.tenant_id = p_tenant;

  INSERT INTO sla_policies (tenant_id, name, priority_id, first_response_minutes, resolution_minutes,
                            business_hours_id, is_default)
  VALUES (p_tenant, 'SLA padrão', NULL, 240, 1440, v_bh, true);
END $$;

-- ---------- provisionamento de tenant ----------
CREATE FUNCTION provision_tenant(p_user uuid, p_name text, p_slug text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant uuid;
BEGIN
  INSERT INTO tenants (name, slug, status, plan_id, trial_ends_at)
  VALUES (p_name, p_slug, 'trial', 'starter', now() + interval '14 days')
  RETURNING id INTO v_tenant;

  INSERT INTO subscriptions (tenant_id, plan_id, status) VALUES (v_tenant, 'starter', 'trialing');
  INSERT INTO memberships (tenant_id, user_id, role) VALUES (v_tenant, p_user, 'admin');
  PERFORM seed_tenant_defaults(v_tenant);
  RETURN v_tenant;
END $$;

-- Cadastro self-service: cria usuário + workspace. E-mail já existente => erro
-- (a pessoa deve entrar e usar create_tenant_for_user, evitando vincular contas alheias).
CREATE FUNCTION signup_tenant(p_name text, p_slug text, p_email citext, p_admin_name text, p_password_hash text)
RETURNS TABLE (out_tenant_id uuid, out_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user   uuid;
  v_tenant uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE email = p_email) THEN
    RAISE EXCEPTION 'email_already_registered' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO users (email, name, password_hash) VALUES (p_email, p_admin_name, p_password_hash)
  RETURNING id INTO v_user;
  v_tenant := provision_tenant(v_user, p_name, p_slug);
  RETURN QUERY SELECT v_tenant, v_user;
END $$;

-- Usuário já autenticado cria outro workspace
CREATE FUNCTION create_tenant_for_user(p_user uuid, p_name text, p_slug text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_user IS DISTINCT FROM app_user_id() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN provision_tenant(p_user, p_name, p_slug);
END $$;

-- ---------- autenticação (roda ANTES de existir contexto de tenant) ----------
CREATE FUNCTION auth_get_user_by_email(p_email citext)
RETURNS TABLE (id uuid, email citext, name text, password_hash text, disabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.email, u.name, u.password_hash, (u.disabled_at IS NOT NULL)
    FROM users u WHERE u.email = p_email
$$;

CREATE FUNCTION auth_list_memberships(p_user uuid)
RETURNS TABLE (tenant_id uuid, tenant_name text, tenant_slug citext, tenant_status tenant_status, role member_role)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.name, t.slug, t.status, m.role
    FROM memberships m JOIN tenants t ON t.id = m.tenant_id
   WHERE m.user_id = p_user AND m.active
   ORDER BY t.name
$$;

CREATE FUNCTION auth_touch_login(p_user uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE users SET last_login_at = now() WHERE id = p_user
$$;

-- Troca de senha (a API valida o token de reset/sessão antes de chamar)
CREATE FUNCTION auth_set_password(p_user uuid, p_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE users SET password_hash = p_hash WHERE id = p_user
$$;

-- Resolve o workspace pelo subdomínio (portal do cliente), antes do login
CREATE FUNCTION tenant_by_slug(p_slug citext)
RETURNS TABLE (id uuid, name text, status tenant_status)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.name, t.status FROM tenants t WHERE t.slug = p_slug
$$;

-- ---------- convites ----------
CREATE FUNCTION accept_invitation(p_token_hash text, p_name text, p_password_hash text)
RETURNS TABLE (out_tenant_id uuid, out_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_inv  invitations%ROWTYPE;
  v_user uuid;
BEGIN
  SELECT * INTO v_inv FROM invitations
   WHERE token_hash = p_token_hash AND accepted_at IS NULL AND expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation_invalid_or_expired' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT id INTO v_user FROM users WHERE email = v_inv.email;
  IF v_user IS NULL THEN
    INSERT INTO users (email, name, password_hash) VALUES (v_inv.email, p_name, p_password_hash)
    RETURNING id INTO v_user;
  ELSE
    UPDATE users SET password_hash = COALESCE(password_hash, p_password_hash) WHERE id = v_user;
  END IF;

  INSERT INTO memberships (tenant_id, user_id, role, organization_id)
  VALUES (v_inv.tenant_id, v_user, v_inv.role, v_inv.organization_id)
  ON CONFLICT (tenant_id, user_id)
  DO UPDATE SET role = EXCLUDED.role, organization_id = EXCLUDED.organization_id, active = true;

  UPDATE invitations SET accepted_at = now() WHERE id = v_inv.id;
  RETURN QUERY SELECT v_inv.tenant_id, v_user;
END $$;

-- ---------- SLA: marcação de estouros (chamada periodicamente pelo worker) ----------
CREATE FUNCTION sla_mark_breaches() RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH breached AS (
    UPDATE sla_timers
       SET breached_at = now()
     WHERE met_at IS NULL AND paused_at IS NULL AND breached_at IS NULL AND due_at <= now()
    RETURNING tenant_id, ticket_id, kind, due_at
  ), ev AS (
    INSERT INTO ticket_events (tenant_id, ticket_id, actor_id, event_type, data)
    SELECT tenant_id, ticket_id, NULL, 'sla_breached',
           jsonb_build_object('kind', kind, 'due_at', due_at)
      FROM breached
    RETURNING 1
  )
  SELECT count(*) FROM ev
$$;

-- Visão por chamado/cronômetro (security_invoker => respeita a RLS de quem consulta)
CREATE VIEW v_ticket_sla WITH (security_invoker = true) AS
SELECT t.tenant_id,
       t.ticket_id,
       t.kind,
       t.due_at,
       t.met_at,
       t.paused_at,
       CASE
         WHEN t.met_at IS NOT NULL AND t.met_at <= t.due_at THEN 'met'
         WHEN t.met_at IS NOT NULL                          THEN 'met_late'
         WHEN t.paused_at IS NOT NULL                       THEN 'paused'
         WHEN now() > t.due_at                              THEN 'breached'
         ELSE 'running'
       END AS state,
       CASE WHEN t.met_at IS NULL AND t.paused_at IS NULL
            THEN FLOOR(EXTRACT(epoch FROM (t.due_at - now())) / 60)::integer END AS minutes_remaining
  FROM sla_timers t;
