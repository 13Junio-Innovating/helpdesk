-- 001: tipos enumerados e funções utilitárias

CREATE TYPE member_role       AS ENUM ('admin', 'agent', 'requester');
CREATE TYPE tenant_status     AS ENUM ('trial', 'active', 'past_due', 'suspended', 'canceled');
CREATE TYPE status_kind       AS ENUM ('open', 'pending', 'on_hold', 'resolved', 'closed');
CREATE TYPE message_kind      AS ENUM ('public_reply', 'internal_note', 'system');
CREATE TYPE ticket_channel    AS ENUM ('portal', 'email', 'chat', 'phone', 'api');
CREATE TYPE sla_timer_kind    AS ENUM ('first_response', 'resolution');
CREATE TYPE automation_event  AS ENUM ('ticket_created', 'ticket_updated', 'sla_warning', 'sla_breached');
CREATE TYPE outbox_status     AS ENUM ('pending', 'sending', 'sent', 'failed');
CREATE TYPE kb_status         AS ENUM ('draft', 'published', 'archived');
CREATE TYPE kb_visibility     AS ENUM ('internal', 'portal');

-- Mantém updated_at automaticamente
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Contexto da requisição. A API deve chamar app_set_context() no início de CADA
-- transação (p_local = true), para que o valor não vaze entre conexões do pool.
CREATE FUNCTION app_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION app_set_context(p_tenant uuid, p_user uuid, p_local boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.tenant_id', COALESCE(p_tenant::text, ''), p_local);
  PERFORM set_config('app.user_id',   COALESCE(p_user::text, ''),   p_local);
END $$;
