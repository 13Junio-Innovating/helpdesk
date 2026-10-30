-- 012: estado durável do worker (idempotência entre execuções e entre instâncias)
--
-- Por que no banco: o worker (sd_worker) precisa lembrar o que já processou para
--   (a) não avaliar o mesmo evento de chamado duas vezes nas automações, mesmo com várias
--       instâncias rodando ou após reinício, e
--   (b) não mandar o alerta de "80% do prazo" duas vezes para o mesmo cronômetro.
-- O sd_worker não cria tabelas, e memória do processo não sobrevive a reinício nem é compartilhada.

CREATE TABLE automation_runs (
  event_id      bigint PRIMARY KEY REFERENCES ticket_events(id) ON DELETE CASCADE,
  tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rules_matched integer     NOT NULL DEFAULT 0,
  -- evento gerado pela própria automação: registrado como processado sem avaliar (evita cascata)
  skipped       boolean     NOT NULL DEFAULT false,
  error         text,
  processed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sla_alerts (
  timer_id  uuid PRIMARY KEY REFERENCES sla_timers(id) ON DELETE CASCADE,
  tenant_id uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sent_at   timestamptz NOT NULL DEFAULT now()
);

-- varredura de eventos recentes ainda não avaliados
CREATE INDEX idx_events_created ON ticket_events (created_at);

ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;   -- sem policy: a API (sd_app) não acessa
ALTER TABLE sla_alerts      ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON automation_runs, sla_alerts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON automation_runs, sla_alerts TO sd_worker;
