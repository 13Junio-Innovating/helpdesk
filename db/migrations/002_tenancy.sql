-- 002: planos, tenants, usuários, memberships, organizações (clientes), convites

-- ---------- planos (dados de referência, globais) ----------
CREATE TABLE plans (
  id                     text PRIMARY KEY,
  name                   text    NOT NULL,
  price_cents            integer NOT NULL CHECK (price_cents >= 0),
  max_agents             integer CHECK (max_agents > 0),          -- NULL = ilimitado
  max_tickets_per_month  integer CHECK (max_tickets_per_month > 0),
  features               jsonb   NOT NULL DEFAULT '{}'::jsonb,
  active                 boolean NOT NULL DEFAULT true
);

INSERT INTO plans (id, name, price_cents, max_agents, max_tickets_per_month, features) VALUES
  ('starter',  'Starter',   4900,  3,    300, '{"kb": true,  "automations": false, "sla": true, "api": false}'),
  ('pro',      'Pro',       9900,  10,  2000, '{"kb": true,  "automations": true,  "sla": true, "api": false}'),
  ('business', 'Business', 19900,  30, NULL,  '{"kb": true,  "automations": true,  "sla": true, "api": true}');

-- ---------- tenants ----------
CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text          NOT NULL,
  slug          citext        NOT NULL UNIQUE
                CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  status        tenant_status NOT NULL DEFAULT 'trial',
  plan_id       text          NOT NULL DEFAULT 'starter' REFERENCES plans(id),
  trial_ends_at timestamptz,
  timezone      text          NOT NULL DEFAULT 'America/Sao_Paulo',
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- numeração sequencial de chamados por tenant (só triggers SECURITY DEFINER tocam aqui)
CREATE TABLE tenant_counters (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_seq bigint NOT NULL DEFAULT 0
);

CREATE TABLE subscriptions (
  tenant_id                uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id                  text NOT NULL REFERENCES plans(id),
  status                   text NOT NULL DEFAULT 'trialing',
  provider                 text,                       -- 'asaas' | 'stripe' | ...
  provider_customer_id     text,
  provider_subscription_id text,
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  cancel_at_period_end     boolean NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_subscriptions_updated BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- idempotência de webhooks de cobrança (acessada só pelo sd_worker)
CREATE TABLE billing_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider     text        NOT NULL,
  event_id     text        NOT NULL,
  tenant_id    uuid REFERENCES tenants(id) ON DELETE SET NULL,
  event_type   text        NOT NULL,
  payload      jsonb       NOT NULL,
  processed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

-- ---------- usuários (identidade global; acesso por tenant via memberships) ----------
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             citext      NOT NULL UNIQUE,
  name              text        NOT NULL,
  password_hash     text,                       -- NULL = convidado ainda sem senha
  locale            text        NOT NULL DEFAULT 'pt-BR',
  avatar_url        text,
  is_platform_admin boolean     NOT NULL DEFAULT false,
  last_login_at     timestamptz,
  disabled_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- organizações (empresas-cliente de quem abre chamados) ----------
CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  document   text,                              -- CNPJ, opcional
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);
CREATE TRIGGER trg_organizations_updated BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- memberships (usuário <-> tenant, com papel) ----------
CREATE TABLE memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  role            member_role NOT NULL,
  organization_id uuid,
  phone           text,
  job_title       text,
  active          boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organizations (tenant_id, id)
);
CREATE INDEX idx_memberships_user ON memberships (user_id);
CREATE TRIGGER trg_memberships_updated BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Papel do usuário corrente no tenant corrente (usado pelas policies de RLS)
CREATE FUNCTION app_role() RETURNS member_role
LANGUAGE sql STABLE AS $$
  SELECT m.role FROM memberships m
   WHERE m.tenant_id = app_tenant_id() AND m.user_id = app_user_id() AND m.active
$$;

CREATE FUNCTION app_is_staff() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(app_role() IN ('admin', 'agent'), false)
$$;

CREATE FUNCTION app_is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(app_role() = 'admin', false)
$$;

-- ---------- convites ----------
CREATE TABLE invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           citext      NOT NULL,
  role            member_role NOT NULL,
  organization_id uuid,
  token_hash      text        NOT NULL UNIQUE,   -- guarde só o hash do token enviado por e-mail
  invited_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organizations (tenant_id, id)
);
CREATE INDEX idx_invitations_tenant ON invitations (tenant_id, email);
