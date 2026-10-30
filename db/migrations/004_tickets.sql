-- 004: chamados e tabelas relacionadas

CREATE TABLE tickets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number           bigint,                                  -- preenchido por trigger (sequencial por tenant)
  subject          text   NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 300),
  description      text   NOT NULL DEFAULT '',
  requester_id     uuid   NOT NULL,
  organization_id  uuid,
  assignee_id      uuid,
  queue_id         uuid,
  category_id      uuid,
  priority_id      uuid   NOT NULL,                         -- default preenchido por trigger BEFORE INSERT
  status_id        uuid   NOT NULL,                         -- idem
  channel          ticket_channel NOT NULL DEFAULT 'portal',
  tags             text[]  NOT NULL DEFAULT '{}',
  custom_fields    jsonb   NOT NULL DEFAULT '{}'::jsonb,
  sla_policy_id    uuid,
  first_response_at timestamptz,
  resolved_at      timestamptz,
  closed_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  search           tsvector GENERATED ALWAYS AS (
                     to_tsvector('portuguese', coalesce(subject, '') || ' ' || coalesce(description, ''))
                   ) STORED,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, requester_id)    REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, assignee_id)     REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organizations (tenant_id, id),
  FOREIGN KEY (tenant_id, queue_id)        REFERENCES queues (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id)     REFERENCES categories (tenant_id, id),
  FOREIGN KEY (tenant_id, priority_id)     REFERENCES priorities (tenant_id, id),
  FOREIGN KEY (tenant_id, status_id)       REFERENCES statuses (tenant_id, id),
  FOREIGN KEY (tenant_id, sla_policy_id)   REFERENCES sla_policies (tenant_id, id)
);
CREATE INDEX idx_tickets_status     ON tickets (tenant_id, status_id, updated_at DESC);
CREATE INDEX idx_tickets_assignee   ON tickets (tenant_id, assignee_id) WHERE assignee_id IS NOT NULL;
CREATE INDEX idx_tickets_requester  ON tickets (tenant_id, requester_id, created_at DESC);
CREATE INDEX idx_tickets_queue      ON tickets (tenant_id, queue_id) WHERE queue_id IS NOT NULL;
CREATE INDEX idx_tickets_org        ON tickets (tenant_id, organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX idx_tickets_created    ON tickets (tenant_id, created_at DESC);
CREATE INDEX idx_tickets_search     ON tickets USING gin (search);
CREATE INDEX idx_tickets_tags       ON tickets USING gin (tags);
CREATE INDEX idx_tickets_subject_trgm ON tickets USING gin (subject gin_trgm_ops);

CREATE TABLE ticket_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  ticket_id  uuid NOT NULL,
  author_id  uuid,                                   -- NULL = mensagem de sistema
  kind       message_kind   NOT NULL DEFAULT 'public_reply',
  body       text           NOT NULL CHECK (char_length(body) > 0),
  channel    ticket_channel NOT NULL DEFAULT 'portal',
  created_at timestamptz    NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, author_id) REFERENCES memberships (tenant_id, user_id),
  CHECK ((kind = 'system') = (author_id IS NULL))
);
CREATE INDEX idx_messages_ticket ON ticket_messages (ticket_id, created_at);

CREATE TABLE attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  ticket_id    uuid NOT NULL,
  message_id   uuid,
  filename     text    NOT NULL,
  content_type text    NOT NULL,
  size_bytes   bigint  NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),   -- 25 MB
  storage_key  text    NOT NULL UNIQUE,                                              -- chave no S3/R2
  uploaded_by  uuid    NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, ticket_id)   REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, message_id)  REFERENCES ticket_messages (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, uploaded_by) REFERENCES memberships (tenant_id, user_id)
);
CREATE INDEX idx_attachments_ticket ON attachments (ticket_id);

-- trilha de auditoria (somente inserção)
CREATE TABLE ticket_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  ticket_id  uuid NOT NULL,
  actor_id   uuid,                                   -- NULL = sistema/automação
  event_type text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_events_ticket ON ticket_events (ticket_id, created_at);

-- apontamento de horas
CREATE TABLE time_entries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  ticket_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  minutes    integer NOT NULL CHECK (minutes BETWEEN 1 AND 1440),
  note       text,
  worked_on  date NOT NULL DEFAULT current_date,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id)   REFERENCES memberships (tenant_id, user_id)
);
CREATE INDEX idx_time_ticket ON time_entries (ticket_id);
CREATE INDEX idx_time_user   ON time_entries (tenant_id, user_id, worked_on);

-- cronômetros de SLA (um por tipo por chamado)
CREATE TABLE sla_timers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  ticket_id      uuid NOT NULL,
  kind           sla_timer_kind NOT NULL,
  due_at         timestamptz    NOT NULL,
  paused_at      timestamptz,
  paused_seconds integer        NOT NULL DEFAULT 0,
  met_at         timestamptz,
  breached_at    timestamptz,
  UNIQUE (ticket_id, kind),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE
);
-- varredura do worker de estouro de SLA
CREATE INDEX idx_sla_open ON sla_timers (due_at) WHERE met_at IS NULL AND paused_at IS NULL AND breached_at IS NULL;
