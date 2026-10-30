-- 005: automações, base de conhecimento e outbox de e-mail

-- Regras avaliadas pelo worker da aplicação. Formato sugerido:
--   conditions: [{"field":"priority.name","op":"eq","value":"Urgente"}]
--   actions:    [{"type":"assign_queue","queue_id":"..."},{"type":"add_tag","value":"vip"}]
CREATE TABLE automation_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text             NOT NULL,
  event      automation_event NOT NULL,
  conditions jsonb            NOT NULL DEFAULT '[]'::jsonb,
  actions    jsonb            NOT NULL DEFAULT '[]'::jsonb,
  position   integer          NOT NULL DEFAULT 0,
  active     boolean          NOT NULL DEFAULT true,
  created_at timestamptz      NOT NULL DEFAULT now(),
  updated_at timestamptz      NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (jsonb_typeof(conditions) = 'array' AND jsonb_typeof(actions) = 'array')
);
CREATE INDEX idx_automation_event ON automation_rules (tenant_id, event, position) WHERE active;
CREATE TRIGGER trg_automation_updated BEFORE UPDATE ON automation_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE kb_articles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category_id uuid,
  title       text          NOT NULL,
  slug        text          NOT NULL,
  body        text          NOT NULL DEFAULT '',
  status      kb_status     NOT NULL DEFAULT 'draft',
  visibility  kb_visibility NOT NULL DEFAULT 'internal',
  author_id   uuid,
  published_at timestamptz,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now(),
  search      tsvector GENERATED ALWAYS AS (
                to_tsvector('portuguese', coalesce(title, '') || ' ' || coalesce(body, ''))
              ) STORED,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, slug),
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories (tenant_id, id) ON DELETE SET NULL (category_id),
  FOREIGN KEY (tenant_id, author_id)   REFERENCES memberships (tenant_id, user_id) ON DELETE SET NULL (author_id)
);
CREATE INDEX idx_kb_search ON kb_articles USING gin (search);
CREATE TRIGGER trg_kb_updated BEFORE UPDATE ON kb_articles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Padrão "transactional outbox": o trigger grava aqui na MESMA transação do chamado;
-- o worker envia o e-mail depois (render do template fica na aplicação).
CREATE TABLE email_outbox (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  to_email     citext        NOT NULL,
  template     text          NOT NULL,           -- 'ticket_created', 'ticket_reply', ...
  payload      jsonb         NOT NULL DEFAULT '{}'::jsonb,
  status       outbox_status NOT NULL DEFAULT 'pending',
  attempts     integer       NOT NULL DEFAULT 0,
  last_error   text,
  scheduled_at timestamptz   NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  created_at   timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX idx_outbox_pending ON email_outbox (scheduled_at) WHERE status IN ('pending', 'failed');
