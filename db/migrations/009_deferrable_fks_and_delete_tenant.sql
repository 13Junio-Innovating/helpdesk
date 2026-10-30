-- 009: exclusão segura de tenant
--
-- As FKs compostas (tenant_id, x_id) criam dependências cruzadas entre tabelas filhas
-- (ex.: ticket_messages -> memberships e -> tickets). No ON DELETE CASCADE a partir de
-- tenants, a ordem de disparo pode checar uma FK antes de a tabela filha ser limpa.
-- Solução: todas as FKs viram DEFERRABLE INITIALLY IMMEDIATE (comportamento normal no dia a dia)
-- e delete_tenant() as adia para o fim da transação.

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conrelid::regclass AS tbl, conname
             FROM pg_constraint
            WHERE contype = 'f' AND connamespace = 'public'::regnamespace AND NOT condeferrable
  LOOP
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE', r.tbl, r.conname);
  END LOOP;
END $$;

-- Remove o workspace e todos os seus dados (encerramento de contrato / pedido LGPD).
-- Usuários que ficarem sem nenhum vínculo também são removidos.
CREATE FUNCTION delete_tenant(p_tenant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_users uuid[];
BEGIN
  SELECT array_agg(user_id) INTO v_users FROM memberships WHERE tenant_id = p_tenant;

  SET CONSTRAINTS ALL DEFERRED;
  DELETE FROM tenants WHERE id = p_tenant;

  DELETE FROM users u
   WHERE u.id = ANY (COALESCE(v_users, '{}'))
     AND NOT u.is_platform_admin
     AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id);
END $$;

REVOKE EXECUTE ON FUNCTION delete_tenant(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION delete_tenant(uuid) TO sd_worker;
