-- 014: estado do worker (automações e alertas de SLA)
--
-- Por que migration: o sd_worker não cria tabelas nem altera sla_timers (008), e o worker precisa
-- lembrar (1) quais eventos de chamado já passaram pelo avaliador de automações e (2) quais
-- cronômetros já receberam o alerta de "SLA perto de vencer". Guardar isso em memória perderia o
-- estado a cada reinício e não funcionaria com várias instâncias.

-- (1) eventos já avaliados. Uma linha por evento; a PK faz o papel de "trava": duas instâncias que
-- tentem o mesmo evento colidem e só uma segue (INSERT ... ON CONFLICT DO NOTHING).
-- Não é um cursor de id porque ids de identity podem ser confirmados fora de ordem (transações
-- concorrentes): um cursor pularia eventos que ficam visíveis depois.
CREATE TABLE automation_runs (
  event_id     bigint PRIMARY KEY REFERENCES ticket_events(id) ON DELETE CASCADE,
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outcome      text        NOT NULL CHECK (outcome IN ('no_match', 'applied', 'skipped', 'error')),
  rules        uuid[]      NOT NULL DEFAULT '{}',   -- regras aplicadas
  error        text,
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_automation_runs_processed ON automation_runs (processed_at);
ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;   -- sem policy: só o worker (BYPASSRLS)

-- varredura dos eventos recentes ainda não avaliados
CREATE INDEX idx_events_created ON ticket_events (created_at);

-- (2) alerta de SLA próximo do vencimento: uma vez por prazo
ALTER TABLE sla_timers ADD COLUMN warned_at timestamptz;

-- Se o prazo mudar (pausa/retomada, troca de prioridade), o alerta vale de novo para o prazo novo.
CREATE FUNCTION fn_sla_timers_reset_warning() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    NEW.warned_at := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_sla_timers_reset_warning BEFORE UPDATE OF due_at ON sla_timers
  FOR EACH ROW EXECUTE FUNCTION fn_sla_timers_reset_warning();

-- ---------- permissões do worker (mínimas) ----------
GRANT SELECT, INSERT, DELETE ON automation_runs TO sd_worker;
GRANT UPDATE (outcome, rules, error) ON automation_runs TO sd_worker;
GRANT UPDATE (warned_at) ON sla_timers TO sd_worker;
