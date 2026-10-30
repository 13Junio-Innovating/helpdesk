-- 003: filas, categorias, prioridades, status, horário comercial e políticas de SLA
-- Toda tabela de tenant tem UNIQUE (tenant_id, id) para permitir FKs compostas,
-- que impedem um registro de apontar para dados de OUTRO tenant.

CREATE TABLE queues (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE queue_members (
  tenant_id uuid NOT NULL,
  queue_id  uuid NOT NULL,
  user_id   uuid NOT NULL,
  PRIMARY KEY (queue_id, user_id),
  FOREIGN KEY (tenant_id, queue_id) REFERENCES queues (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id)  REFERENCES memberships (tenant_id, user_id) ON DELETE CASCADE
);

CREATE TABLE categories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id        uuid,
  name             text NOT NULL,
  default_queue_id uuid,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id)        REFERENCES categories (tenant_id, id),
  FOREIGN KEY (tenant_id, default_queue_id) REFERENCES queues (tenant_id, id) ON DELETE SET NULL (default_queue_id)
);
CREATE UNIQUE INDEX uq_categories_name
  ON categories (tenant_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

CREATE TABLE priorities (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text     NOT NULL,
  level      smallint NOT NULL CHECK (level BETWEEN 1 AND 10),   -- maior = mais urgente
  color      text     NOT NULL DEFAULT '#64748b',
  is_default boolean  NOT NULL DEFAULT false,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);
CREATE UNIQUE INDEX uq_priorities_default ON priorities (tenant_id) WHERE is_default;

CREATE TABLE statuses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text        NOT NULL,
  kind       status_kind NOT NULL,
  sla_pauses boolean     NOT NULL DEFAULT false,   -- ex.: "Aguardando cliente" pausa o SLA
  is_default boolean     NOT NULL DEFAULT false,   -- status inicial de novos chamados
  position   smallint    NOT NULL DEFAULT 0,
  color      text        NOT NULL DEFAULT '#64748b',
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);
CREATE UNIQUE INDEX uq_statuses_default ON statuses (tenant_id) WHERE is_default;

-- ---------- horário comercial ----------
CREATE TABLE business_hours (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  timezone   text NOT NULL DEFAULT 'America/Sao_Paulo',
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE business_hour_slots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid     NOT NULL,
  business_hours_id uuid     NOT NULL,
  weekday           smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),   -- 0 = domingo
  start_time        time     NOT NULL,
  end_time          time     NOT NULL,
  CHECK (end_time > start_time),
  FOREIGN KEY (tenant_id, business_hours_id) REFERENCES business_hours (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_bh_slots ON business_hour_slots (business_hours_id, weekday, start_time);

CREATE TABLE business_holidays (
  tenant_id         uuid NOT NULL,
  business_hours_id uuid NOT NULL,
  holiday_date      date NOT NULL,
  name              text,
  PRIMARY KEY (business_hours_id, holiday_date),
  FOREIGN KEY (tenant_id, business_hours_id) REFERENCES business_hours (tenant_id, id) ON DELETE CASCADE
);

-- ---------- políticas de SLA ----------
CREATE TABLE sla_policies (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                   text    NOT NULL,
  priority_id            uuid,                         -- NULL = política padrão (fallback)
  first_response_minutes integer NOT NULL CHECK (first_response_minutes > 0),
  resolution_minutes     integer NOT NULL CHECK (resolution_minutes > 0),
  business_hours_id      uuid,                         -- NULL = 24x7
  is_default             boolean NOT NULL DEFAULT false,
  active                 boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  CHECK (resolution_minutes >= first_response_minutes),
  FOREIGN KEY (tenant_id, priority_id)       REFERENCES priorities (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, business_hours_id) REFERENCES business_hours (tenant_id, id)
);
CREATE UNIQUE INDEX uq_sla_policy_priority ON sla_policies (tenant_id, priority_id)
  WHERE priority_id IS NOT NULL AND active;
CREATE UNIQUE INDEX uq_sla_policy_default ON sla_policies (tenant_id) WHERE is_default;

-- Soma `p_minutes` minutos ÚTEIS a partir de p_start, respeitando faixas semanais e feriados.
-- Sem faixas cadastradas, cai para minutos corridos.
CREATE FUNCTION sla_add_business_minutes(p_bh uuid, p_start timestamptz, p_minutes integer)
RETURNS timestamptz
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_tz        text;
  v_remaining integer := p_minutes;
  v_cursor    timestamptz := p_start;
  v_day       date;
  v_slot      record;
  v_slot_start timestamptz;
  v_slot_end   timestamptz;
  v_from       timestamptz;
  v_avail      integer;
  v_days       integer := 0;
BEGIN
  IF p_bh IS NULL THEN
    RETURN p_start + make_interval(mins => p_minutes);
  END IF;

  SELECT timezone INTO v_tz FROM business_hours WHERE id = p_bh;
  IF v_tz IS NULL OR NOT EXISTS (SELECT 1 FROM business_hour_slots WHERE business_hours_id = p_bh) THEN
    RETURN p_start + make_interval(mins => p_minutes);
  END IF;

  v_day := (p_start AT TIME ZONE v_tz)::date;

  WHILE v_days < 800 LOOP     -- trava de segurança (~2 anos)
    IF NOT EXISTS (SELECT 1 FROM business_holidays WHERE business_hours_id = p_bh AND holiday_date = v_day) THEN
      FOR v_slot IN
        SELECT start_time, end_time FROM business_hour_slots
         WHERE business_hours_id = p_bh AND weekday = EXTRACT(dow FROM v_day)::smallint
         ORDER BY start_time
      LOOP
        v_slot_start := (v_day + v_slot.start_time) AT TIME ZONE v_tz;
        v_slot_end   := (v_day + v_slot.end_time)   AT TIME ZONE v_tz;
        IF v_cursor < v_slot_end THEN
          v_from  := GREATEST(v_cursor, v_slot_start);
          v_avail := FLOOR(EXTRACT(epoch FROM (v_slot_end - v_from)) / 60)::integer;
          IF v_remaining <= v_avail THEN
            RETURN v_from + make_interval(mins => v_remaining);
          END IF;
          v_remaining := v_remaining - v_avail;
          v_cursor    := v_slot_end;
        END IF;
      END LOOP;
    END IF;
    v_day  := v_day + 1;
    v_days := v_days + 1;
  END LOOP;

  RETURN p_start + make_interval(mins => p_minutes);   -- fallback improvável
END $$;
