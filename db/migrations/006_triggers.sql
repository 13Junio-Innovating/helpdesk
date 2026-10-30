-- 006: regras de negócio no banco (numeração, defaults, SLA, auditoria, outbox, limites do plano)
-- Triggers são SECURITY DEFINER: precisam ler/escrever tabelas que o papel do usuário
-- (ex.: solicitante) não enxerga via RLS. Sempre filtram por NEW.tenant_id.

-- ---------- SLA ----------
CREATE FUNCTION sla_pick_policy(p_tenant uuid, p_priority uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM sla_policies
   WHERE tenant_id = p_tenant AND active
     AND (priority_id = p_priority OR (priority_id IS NULL AND is_default))
   ORDER BY (priority_id IS NOT NULL) DESC
   LIMIT 1
$$;

-- ---------- tickets: BEFORE INSERT ----------
CREATE FUNCTION fn_tickets_bi() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant tenants%ROWTYPE;
  v_max    integer;
  v_count  bigint;
BEGIN
  SELECT * INTO v_tenant FROM tenants WHERE id = NEW.tenant_id;
  IF v_tenant.status IN ('suspended', 'canceled') THEN
    RAISE EXCEPTION 'tenant_inactive' USING ERRCODE = 'check_violation';
  END IF;

  SELECT max_tickets_per_month INTO v_max FROM plans WHERE id = v_tenant.plan_id;
  IF v_max IS NOT NULL THEN
    SELECT count(*) INTO v_count FROM tickets
     WHERE tenant_id = NEW.tenant_id
       AND created_at >= date_trunc('month', now() AT TIME ZONE v_tenant.timezone) AT TIME ZONE v_tenant.timezone;
    IF v_count >= v_max THEN
      RAISE EXCEPTION 'ticket_quota_exceeded' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- número sequencial por tenant (sem buracos além de rollbacks)
  INSERT INTO tenant_counters AS c (tenant_id, ticket_seq) VALUES (NEW.tenant_id, 1)
  ON CONFLICT (tenant_id) DO UPDATE SET ticket_seq = c.ticket_seq + 1
  RETURNING c.ticket_seq INTO NEW.number;

  -- cliente (solicitante) não define status, prioridade, fila nem responsável
  IF app_role() = 'requester' THEN
    NEW.status_id   := NULL;
    NEW.priority_id := NULL;
    NEW.queue_id    := NULL;
    NEW.assignee_id := NULL;
  END IF;

  IF NEW.status_id IS NULL THEN
    SELECT id INTO NEW.status_id FROM statuses WHERE tenant_id = NEW.tenant_id AND is_default;
  END IF;
  IF NEW.priority_id IS NULL THEN
    SELECT id INTO NEW.priority_id FROM priorities WHERE tenant_id = NEW.tenant_id AND is_default;
  END IF;
  IF NEW.organization_id IS NULL THEN
    SELECT organization_id INTO NEW.organization_id
      FROM memberships WHERE tenant_id = NEW.tenant_id AND user_id = NEW.requester_id;
  END IF;
  IF NEW.queue_id IS NULL AND NEW.category_id IS NOT NULL THEN
    SELECT default_queue_id INTO NEW.queue_id
      FROM categories WHERE tenant_id = NEW.tenant_id AND id = NEW.category_id;
  END IF;

  IF NEW.assignee_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM memberships
        WHERE tenant_id = NEW.tenant_id AND user_id = NEW.assignee_id AND role IN ('admin', 'agent') AND active) THEN
    RAISE EXCEPTION 'assignee_must_be_staff' USING ERRCODE = 'check_violation';
  END IF;

  NEW.sla_policy_id     := sla_pick_policy(NEW.tenant_id, NEW.priority_id);
  NEW.first_response_at := NULL;
  NEW.resolved_at       := NULL;
  NEW.closed_at         := NULL;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_tickets_bi BEFORE INSERT ON tickets
  FOR EACH ROW EXECUTE FUNCTION fn_tickets_bi();

-- ---------- tickets: AFTER INSERT ----------
CREATE FUNCTION fn_tickets_ai() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  p sla_policies%ROWTYPE;
BEGIN
  IF NEW.sla_policy_id IS NOT NULL THEN
    SELECT * INTO p FROM sla_policies WHERE id = NEW.sla_policy_id;
    INSERT INTO sla_timers (tenant_id, ticket_id, kind, due_at) VALUES
      (NEW.tenant_id, NEW.id, 'first_response',
         sla_add_business_minutes(p.business_hours_id, NEW.created_at, p.first_response_minutes)),
      (NEW.tenant_id, NEW.id, 'resolution',
         sla_add_business_minutes(p.business_hours_id, NEW.created_at, p.resolution_minutes));
  END IF;

  INSERT INTO ticket_events (tenant_id, ticket_id, actor_id, event_type, data)
  VALUES (NEW.tenant_id, NEW.id, app_user_id(), 'created',
          jsonb_build_object('number', NEW.number, 'channel', NEW.channel));

  INSERT INTO email_outbox (tenant_id, to_email, template, payload)
  SELECT NEW.tenant_id, u.email, 'ticket_created',
         jsonb_build_object('ticket_id', NEW.id, 'number', NEW.number, 'subject', NEW.subject)
    FROM users u WHERE u.id = NEW.requester_id;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_tickets_ai AFTER INSERT ON tickets
  FOR EACH ROW EXECUTE FUNCTION fn_tickets_ai();

-- ---------- tickets: BEFORE UPDATE ----------
CREATE FUNCTION fn_tickets_bu() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_kind status_kind;
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'tenant_id is immutable' USING ERRCODE = 'check_violation';
  END IF;
  NEW.number     := OLD.number;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := now();

  IF NEW.assignee_id IS NOT NULL AND NEW.assignee_id IS DISTINCT FROM OLD.assignee_id AND NOT EXISTS (
       SELECT 1 FROM memberships
        WHERE tenant_id = NEW.tenant_id AND user_id = NEW.assignee_id AND role IN ('admin', 'agent') AND active) THEN
    RAISE EXCEPTION 'assignee_must_be_staff' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.priority_id IS DISTINCT FROM OLD.priority_id THEN
    NEW.sla_policy_id := sla_pick_policy(NEW.tenant_id, NEW.priority_id);
  END IF;

  IF NEW.status_id IS DISTINCT FROM OLD.status_id THEN
    SELECT kind INTO v_kind FROM statuses WHERE tenant_id = NEW.tenant_id AND id = NEW.status_id;
    IF v_kind IN ('resolved', 'closed') THEN
      NEW.resolved_at := COALESCE(OLD.resolved_at, now());
    ELSE
      NEW.resolved_at := NULL;
    END IF;
    IF v_kind = 'closed' THEN
      NEW.closed_at := COALESCE(OLD.closed_at, now());
    ELSE
      NEW.closed_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_tickets_bu BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION fn_tickets_bu();

-- ---------- tickets: AFTER UPDATE (auditoria + SLA) ----------
CREATE FUNCTION fn_tickets_au() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor    uuid := app_user_id();
  v_old      statuses%ROWTYPE;
  v_new      statuses%ROWTYPE;
  p          sla_policies%ROWTYPE;
  t          sla_timers%ROWTYPE;
  v_due      timestamptz;
  v_mins     integer;
BEGIN
  -- ----- auditoria -----
  IF NEW.status_id IS DISTINCT FROM OLD.status_id THEN
    SELECT * INTO v_old FROM statuses WHERE id = OLD.status_id;
    SELECT * INTO v_new FROM statuses WHERE id = NEW.status_id;
    INSERT INTO ticket_events (tenant_id, ticket_id, actor_id, event_type, data)
    VALUES (NEW.tenant_id, NEW.id, v_actor, 'status_changed',
            jsonb_build_object('from', v_old.name, 'to', v_new.name));

    -- pausa / retoma / encerra cronômetros
    IF v_new.kind IN ('resolved', 'closed') THEN
      UPDATE sla_timers SET met_at = now(), paused_at = NULL
       WHERE ticket_id = NEW.id AND met_at IS NULL;
    ELSE
      IF v_old.kind IN ('resolved', 'closed') THEN   -- reabertura
        UPDATE sla_timers
           SET met_at = CASE kind WHEN 'first_response' THEN NEW.first_response_at ELSE NULL END
         WHERE ticket_id = NEW.id;
      END IF;
      IF v_new.sla_pauses THEN
        UPDATE sla_timers SET paused_at = now()
         WHERE ticket_id = NEW.id AND paused_at IS NULL AND met_at IS NULL;
      ELSE
        UPDATE sla_timers
           SET due_at         = due_at + (now() - paused_at),
               paused_seconds = paused_seconds + EXTRACT(epoch FROM (now() - paused_at))::integer,
               paused_at      = NULL
         WHERE ticket_id = NEW.id AND paused_at IS NOT NULL;
      END IF;
    END IF;
  END IF;

  IF NEW.assignee_id IS DISTINCT FROM OLD.assignee_id THEN
    INSERT INTO ticket_events (tenant_id, ticket_id, actor_id, event_type, data)
    VALUES (NEW.tenant_id, NEW.id, v_actor, 'assigned',
            jsonb_build_object('from', OLD.assignee_id, 'to', NEW.assignee_id));
  END IF;
  IF NEW.queue_id IS DISTINCT FROM OLD.queue_id THEN
    INSERT INTO ticket_events (tenant_id, ticket_id, actor_id, event_type, data)
    VALUES (NEW.tenant_id, NEW.id, v_actor, 'queue_changed',
            jsonb_build_object('from', OLD.queue_id, 'to', NEW.queue_id));
  END IF;
  IF NEW.category_id IS DISTINCT FROM OLD.category_id THEN
    INSERT INTO ticket_events (tenant_id, ticket_id, actor_id, event_type, data)
    VALUES (NEW.tenant_id, NEW.id, v_actor, 'category_changed',
            jsonb_build_object('from', OLD.category_id, 'to', NEW.category_id));
  END IF;

  -- ----- mudança de prioridade: recalcula prazos ainda abertos -----
  IF NEW.priority_id IS DISTINCT FROM OLD.priority_id THEN
    INSERT INTO ticket_events (tenant_id, ticket_id, actor_id, event_type, data)
    VALUES (NEW.tenant_id, NEW.id, v_actor, 'priority_changed',
            jsonb_build_object('from', OLD.priority_id, 'to', NEW.priority_id));

    IF NEW.sla_policy_id IS NOT NULL THEN
      SELECT * INTO p FROM sla_policies WHERE id = NEW.sla_policy_id;

      -- cria os timers se o chamado ainda não tinha política
      INSERT INTO sla_timers (tenant_id, ticket_id, kind, due_at, met_at) VALUES
        (NEW.tenant_id, NEW.id, 'first_response',
           sla_add_business_minutes(p.business_hours_id, NEW.created_at, p.first_response_minutes),
           NEW.first_response_at),
        (NEW.tenant_id, NEW.id, 'resolution',
           sla_add_business_minutes(p.business_hours_id, NEW.created_at, p.resolution_minutes),
           NEW.resolved_at)
      ON CONFLICT (ticket_id, kind) DO NOTHING;

      FOR t IN SELECT * FROM sla_timers WHERE ticket_id = NEW.id AND met_at IS NULL LOOP
        v_mins := CASE t.kind WHEN 'first_response' THEN p.first_response_minutes ELSE p.resolution_minutes END;
        v_due  := sla_add_business_minutes(p.business_hours_id, NEW.created_at, v_mins)
                  + make_interval(secs => t.paused_seconds);
        UPDATE sla_timers
           SET due_at      = v_due,
               breached_at = CASE WHEN v_due > now() THEN NULL ELSE breached_at END
         WHERE id = t.id;
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_tickets_au AFTER UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION fn_tickets_au();

-- ---------- mensagens: AFTER INSERT ----------
CREATE FUNCTION fn_messages_ai() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ticket  tickets%ROWTYPE;
  v_role    member_role;
  v_status  statuses%ROWTYPE;
  v_default uuid;
BEGIN
  SELECT * INTO v_ticket FROM tickets WHERE tenant_id = NEW.tenant_id AND id = NEW.ticket_id;

  IF NEW.author_id IS NOT NULL THEN
    SELECT role INTO v_role FROM memberships
     WHERE tenant_id = NEW.tenant_id AND user_id = NEW.author_id;
  END IF;

  IF NEW.kind = 'public_reply' AND v_role IN ('admin', 'agent') THEN
    IF v_ticket.first_response_at IS NULL THEN
      UPDATE tickets SET first_response_at = NEW.created_at WHERE id = v_ticket.id;
      UPDATE sla_timers SET met_at = NEW.created_at
       WHERE ticket_id = v_ticket.id AND kind = 'first_response' AND met_at IS NULL;
    END IF;
    IF NEW.author_id <> v_ticket.requester_id THEN
      INSERT INTO email_outbox (tenant_id, to_email, template, payload)
      SELECT NEW.tenant_id, u.email, 'ticket_reply',
             jsonb_build_object('ticket_id', v_ticket.id, 'number', v_ticket.number,
                                'subject', v_ticket.subject, 'message_id', NEW.id)
        FROM users u WHERE u.id = v_ticket.requester_id;
    END IF;

  ELSIF NEW.kind = 'public_reply' AND NEW.author_id = v_ticket.requester_id THEN
    -- cliente respondeu: "Aguardando cliente" / "Resolvido" voltam para o status inicial
    SELECT * INTO v_status FROM statuses WHERE id = v_ticket.status_id;
    IF v_status.kind IN ('pending', 'resolved') THEN
      SELECT id INTO v_default FROM statuses WHERE tenant_id = NEW.tenant_id AND is_default;
      IF v_default IS NOT NULL THEN
        UPDATE tickets SET status_id = v_default WHERE id = v_ticket.id;
      END IF;
    END IF;
  END IF;

  UPDATE tickets SET updated_at = now() WHERE id = v_ticket.id;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_messages_ai AFTER INSERT ON ticket_messages
  FOR EACH ROW EXECUTE FUNCTION fn_messages_ai();

-- ---------- limite de agentes do plano ----------
CREATE FUNCTION fn_memberships_limit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_max   integer;
  v_count bigint;
BEGIN
  IF NEW.role IN ('admin', 'agent') AND NEW.active
     AND (TG_OP = 'INSERT' OR OLD.role = 'requester' OR NOT OLD.active) THEN
    PERFORM 1 FROM tenants WHERE id = NEW.tenant_id FOR UPDATE;   -- serializa concorrência
    SELECT p.max_agents INTO v_max
      FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = NEW.tenant_id;
    IF v_max IS NOT NULL THEN
      SELECT count(*) INTO v_count FROM memberships
       WHERE tenant_id = NEW.tenant_id AND role IN ('admin', 'agent') AND active AND id <> NEW.id;
      IF v_count >= v_max THEN
        RAISE EXCEPTION 'agent_limit_reached' USING ERRCODE = 'check_violation',
          HINT = 'Faça upgrade do plano para adicionar mais agentes.';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_memberships_limit BEFORE INSERT OR UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION fn_memberships_limit();
