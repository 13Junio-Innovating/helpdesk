-- 011: respostas prontas (macros) e visões salvas de filtros
-- Ambas pertencem a um membro da equipe; "shared" libera leitura para os demais da equipe.
-- Escrever: dono ou admin. Clientes (requester) não enxergam nada disso.

CREATE TABLE macros (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_id   uuid NOT NULL,
  name       text    NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  body       text    NOT NULL CHECK (char_length(body) > 0),   -- aceita variáveis como {{solicitante.nome}} (render na aplicação)
  shared     boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES memberships (tenant_id, user_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX uq_macros_name ON macros (tenant_id, owner_id, lower(name));
CREATE TRIGGER trg_macros_updated BEFORE UPDATE ON macros
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE saved_views (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_id   uuid NOT NULL,
  name       text     NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  filters    jsonb    NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object'),
  shared     boolean  NOT NULL DEFAULT false,
  position   smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES memberships (tenant_id, user_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
CREATE UNIQUE INDEX uq_saved_views_name ON saved_views (tenant_id, owner_id, lower(name));
CREATE TRIGGER trg_saved_views_updated BEFORE UPDATE ON saved_views
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE macros      ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['macros', 'saved_views'] LOOP
    EXECUTE format($p$CREATE POLICY %I ON %I FOR SELECT USING (
        tenant_id = app_tenant_id() AND (SELECT app_is_staff())
        AND (shared OR owner_id = app_user_id() OR (SELECT app_is_admin())))$p$, t || '_select', t);
    EXECUTE format($p$CREATE POLICY %I ON %I FOR ALL
        USING (tenant_id = app_tenant_id() AND (SELECT app_is_staff())
               AND (owner_id = app_user_id() OR (SELECT app_is_admin())))
        WITH CHECK (tenant_id = app_tenant_id() AND (SELECT app_is_staff())
               AND (owner_id = app_user_id() OR (SELECT app_is_admin())))$p$, t || '_write', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON macros, saved_views TO sd_app;
