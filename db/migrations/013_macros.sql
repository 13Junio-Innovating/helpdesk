-- 013: respostas prontas (macros) da equipe
--
-- Por que no banco: não havia onde guardar textos compartilhados pela equipe. Guardar no navegador
-- não compartilha entre agentes; reaproveitar kb_articles misturaria conteúdo do cliente com
-- textos internos. Mesmo modelo do catálogo: equipe lê, admin escreve.

CREATE TABLE macros (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title      text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, title)
);
CREATE TRIGGER trg_macros_updated BEFORE UPDATE ON macros FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE macros ENABLE ROW LEVEL SECURITY;
CREATE POLICY macros_select ON macros FOR SELECT
  USING (tenant_id = app_tenant_id() AND (SELECT app_is_staff()));
CREATE POLICY macros_admin ON macros FOR ALL
  USING (tenant_id = app_tenant_id() AND (SELECT app_is_admin()))
  WITH CHECK (tenant_id = app_tenant_id() AND (SELECT app_is_admin()));

REVOKE ALL ON macros FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON macros TO sd_app;
GRANT SELECT ON macros TO sd_worker;
