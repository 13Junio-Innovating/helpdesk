-- 012: relatório de visão geral calculado em SQL
--
-- SECURITY INVOKER (padrão): roda com a RLS de quem chama, então só enxerga o próprio tenant
-- e só a equipe pode usar. Dias agrupados no fuso do tenant.
-- Tempos médios são em minutos CORRIDOS (primeira resposta e resolução), não úteis.

CREATE FUNCTION report_overview(p_from timestamptz DEFAULT now() - interval '30 days',
                                p_to   timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_tz     text;
  v_d_from date;
  v_d_to   date;
BEGIN
  IF NOT app_is_staff() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_to <= p_from OR p_to - p_from > interval '366 days' THEN
    RAISE EXCEPTION 'invalid_period' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT timezone INTO v_tz FROM tenants WHERE id = app_tenant_id();
  v_d_from := (p_from AT TIME ZONE v_tz)::date;
  v_d_to   := (p_to   AT TIME ZONE v_tz)::date;

  RETURN jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', v_tz),

    -- retrato atual (não depende do período)
    'open_by_status', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('status', x.name, 'kind', x.kind,
                                                   'color', x.color, 'count', x.n) ORDER BY x.position), '[]'::jsonb)
        FROM (SELECT s.name, s.kind, s.color, s.position, count(t.id) AS n
                FROM statuses s LEFT JOIN tickets t ON t.status_id = s.id
               GROUP BY s.id) x),

    'totals', jsonb_build_object(
      'open', (SELECT count(*) FROM tickets t JOIN statuses s ON s.id = t.status_id
                WHERE s.kind IN ('open', 'pending', 'on_hold')),
      'unassigned_open', (SELECT count(*) FROM tickets t JOIN statuses s ON s.id = t.status_id
                           WHERE s.kind IN ('open', 'pending', 'on_hold') AND t.assignee_id IS NULL),
      'sla_breached_open', (
        SELECT count(DISTINCT k.ticket_id)
          FROM sla_timers k
          JOIN tickets t  ON t.id = k.ticket_id
          JOIN statuses s ON s.id = t.status_id
         WHERE s.kind IN ('open', 'pending', 'on_hold') AND k.met_at IS NULL
           AND (k.breached_at IS NOT NULL OR (k.paused_at IS NULL AND k.due_at < now()))),
      -- dentro do período
      'created',  (SELECT count(*) FROM tickets WHERE created_at  >= p_from AND created_at  < p_to),
      'resolved', (SELECT count(*) FROM tickets WHERE resolved_at >= p_from AND resolved_at < p_to),
      'time_logged_minutes', (SELECT COALESCE(sum(minutes), 0) FROM time_entries
                               WHERE worked_on BETWEEN v_d_from AND v_d_to)
    ),

    'avg_first_response_minutes', (
      SELECT round((avg(extract(epoch FROM (first_response_at - created_at)) / 60))::numeric, 1)
        FROM tickets
       WHERE created_at >= p_from AND created_at < p_to AND first_response_at IS NOT NULL),
    'avg_resolution_minutes', (
      SELECT round((avg(extract(epoch FROM (resolved_at - created_at)) / 60))::numeric, 1)
        FROM tickets
       WHERE created_at >= p_from AND created_at < p_to AND resolved_at IS NOT NULL),

    -- % de cronômetros encerrados (ou estourados) que cumpriram o prazo; NULL se ainda não há base
    'sla_compliance_pct', (
      SELECT round(100.0 * count(*) FILTER (WHERE k.met_at IS NOT NULL AND k.met_at <= k.due_at)
                   / NULLIF(count(*) FILTER (WHERE k.met_at IS NOT NULL OR k.breached_at IS NOT NULL), 0), 1)
        FROM sla_timers k JOIN tickets t ON t.id = k.ticket_id
       WHERE t.created_at >= p_from AND t.created_at < p_to),

    'daily', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('day', d.day, 'created', COALESCE(c.n, 0),
                                                   'resolved', COALESCE(r.n, 0)) ORDER BY d.day), '[]'::jsonb)
        FROM (SELECT g::date AS day FROM generate_series(v_d_from, v_d_to, interval '1 day') g) d
        LEFT JOIN (SELECT (created_at AT TIME ZONE v_tz)::date AS day, count(*) AS n FROM tickets
                    WHERE created_at >= p_from AND created_at < p_to GROUP BY 1) c USING (day)
        LEFT JOIN (SELECT (resolved_at AT TIME ZONE v_tz)::date AS day, count(*) AS n FROM tickets
                    WHERE resolved_at >= p_from AND resolved_at < p_to GROUP BY 1) r USING (day)),

    'by_agent', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id', a.user_id, 'name', a.name, 'open', a.open_n,
                                                   'resolved', a.resolved_n, 'minutes_logged', a.minutes)
                                ORDER BY a.name), '[]'::jsonb)
        FROM (SELECT m.user_id, u.name,
                     (SELECT count(*) FROM tickets t JOIN statuses s ON s.id = t.status_id
                       WHERE t.assignee_id = m.user_id AND s.kind IN ('open', 'pending', 'on_hold')) AS open_n,
                     (SELECT count(*) FROM tickets t
                       WHERE t.assignee_id = m.user_id AND t.resolved_at >= p_from AND t.resolved_at < p_to) AS resolved_n,
                     (SELECT COALESCE(sum(e.minutes), 0) FROM time_entries e
                       WHERE e.user_id = m.user_id AND e.worked_on BETWEEN v_d_from AND v_d_to) AS minutes
                FROM memberships m JOIN users u ON u.id = m.user_id
               WHERE m.role IN ('admin', 'agent') AND m.active) a),

    'by_category', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('category', x.name, 'count', x.n) ORDER BY x.n DESC, x.name), '[]'::jsonb)
        FROM (SELECT COALESCE(c.name, 'Sem categoria') AS name, count(*) AS n
                FROM tickets t LEFT JOIN categories c ON c.id = t.category_id
               WHERE t.created_at >= p_from AND t.created_at < p_to
               GROUP BY COALESCE(c.name, 'Sem categoria')) x),

    'by_priority', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('priority', x.name, 'color', x.color, 'count', x.n) ORDER BY x.level DESC), '[]'::jsonb)
        FROM (SELECT p.name, p.color, p.level, count(t.id) AS n
                FROM priorities p
                LEFT JOIN tickets t ON t.priority_id = p.id AND t.created_at >= p_from AND t.created_at < p_to
               GROUP BY p.id) x)
  );
END $$;

REVOKE EXECUTE ON FUNCTION report_overview(timestamptz, timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION report_overview(timestamptz, timestamptz) TO sd_app;

-- ---------- apontamento de horas: "hoje" no fuso do tenant ----------
-- worked_on usava current_date (fuso do servidor, em geral UTC). À noite no Brasil isso gravava o
-- dia seguinte e o relatório (que agrupa pelo fuso do tenant) deixava as horas de fora.
ALTER TABLE time_entries ALTER COLUMN worked_on DROP DEFAULT;

CREATE FUNCTION fn_time_entries_bi() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.worked_on IS NULL THEN
    NEW.worked_on := (now() AT TIME ZONE (SELECT timezone FROM tenants WHERE id = NEW.tenant_id))::date;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_time_entries_bi BEFORE INSERT ON time_entries
  FOR EACH ROW EXECUTE FUNCTION fn_time_entries_bi();
