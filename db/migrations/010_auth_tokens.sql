-- 010: refresh tokens com rotação/detecção de reuso e recuperação de senha
--
-- Só o HASH (SHA-256, calculado pela API) dos tokens é guardado. As tabelas não têm GRANT
-- para sd_app: todo acesso passa pelas funções SECURITY DEFINER abaixo.
-- As funções devolvem STATUS em vez de lançar exceção ao detectar reuso, porque uma exceção
-- desfaria (ROLLBACK) a revogação da família de tokens que queremos justamente persistir.

-- Daqui em diante, funções novas do sd_owner NÃO ficam executáveis por PUBLIC por padrão.
-- (O ALTER DEFAULT PRIVILEGES ... IN SCHEMA da 008 não remove o privilégio padrão global.)
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid        NOT NULL,                      -- uma "sessão" de login
  user_id     uuid        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  tenant_id   uuid                 REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash  text        NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_family ON refresh_tokens (family_id);
CREATE INDEX idx_refresh_user   ON refresh_tokens (user_id);
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;       -- sem policy: só funções DEFINER / owner

CREATE TABLE password_resets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text        NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pwreset_user ON password_resets (user_id);
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;

-- ---------- refresh tokens ----------
-- Abre uma nova sessão (nova família). Devolve o family_id.
CREATE FUNCTION auth_issue_refresh(p_user uuid, p_tenant uuid, p_token_hash text,
                                   p_ttl interval DEFAULT interval '30 days')
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_family uuid := gen_random_uuid();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user AND disabled_at IS NULL) THEN
    RAISE EXCEPTION 'user_unavailable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_tenant IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM memberships WHERE tenant_id = p_tenant AND user_id = p_user AND active) THEN
    RAISE EXCEPTION 'not_a_member' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO refresh_tokens (family_id, user_id, tenant_id, token_hash, expires_at)
  VALUES (v_family, p_user, p_tenant, p_token_hash, now() + p_ttl);
  RETURN v_family;
END $$;

-- Troca um refresh token por outro (rotação). status: 'ok' | 'reused' | 'invalid'.
--  * 'reused'  => o token já tinha sido usado/revogado: alguém pode tê-lo roubado; a sessão
--                 inteira (família) é revogada. A API deve responder 401 e limpar o cookie.
--  * 'invalid' => desconhecido, expirado, usuário desativado ou vínculo com o workspace perdido.
CREATE FUNCTION auth_rotate_refresh(p_old_hash text, p_new_hash text,
                                    p_ttl interval DEFAULT interval '30 days')
RETURNS TABLE (status text, user_id uuid, tenant_id uuid, family_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  t refresh_tokens%ROWTYPE;
BEGIN
  SELECT * INTO t FROM refresh_tokens WHERE token_hash = p_old_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid, NULL::uuid; RETURN;
  END IF;

  IF t.revoked_at IS NOT NULL THEN
    UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = t.family_id AND revoked_at IS NULL;
    RETURN QUERY SELECT 'reused'::text, t.user_id, t.tenant_id, t.family_id; RETURN;
  END IF;

  IF t.expires_at <= now()
     OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = t.user_id AND u.disabled_at IS NULL)
     OR (t.tenant_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM memberships m WHERE m.tenant_id = t.tenant_id AND m.user_id = t.user_id AND m.active)) THEN
    UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = t.family_id AND revoked_at IS NULL;
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid, NULL::uuid; RETURN;
  END IF;

  UPDATE refresh_tokens SET revoked_at = now() WHERE id = t.id;
  INSERT INTO refresh_tokens (family_id, user_id, tenant_id, token_hash, expires_at)
  VALUES (t.family_id, t.user_id, t.tenant_id, p_new_hash, now() + p_ttl);
  RETURN QUERY SELECT 'ok'::text, t.user_id, t.tenant_id, t.family_id;
END $$;

-- Logout: revoga a sessão (família) do token informado. Idempotente.
CREATE FUNCTION auth_revoke_refresh(p_token_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE refresh_tokens SET revoked_at = now()
   WHERE revoked_at IS NULL
     AND family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = p_token_hash)
$$;

-- "Sair de todos os dispositivos"
CREATE FUNCTION auth_revoke_all_refresh(p_user uuid) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH r AS (UPDATE refresh_tokens SET revoked_at = now()
              WHERE user_id = p_user AND revoked_at IS NULL RETURNING 1)
  SELECT count(*)::integer FROM r
$$;

-- ---------- recuperação de senha ----------
-- Devolve uma linha se o e-mail existe e está ativo (a API envia o e-mail); NENHUMA linha caso contrário.
-- A API deve responder SEMPRE igual ("se o e-mail existir, enviaremos o link"). Pedidos anteriores
-- ainda não usados ficam inválidos. Validade: 1 hora.
CREATE FUNCTION auth_request_password_reset(p_email citext, p_token_hash text)
RETURNS TABLE (out_user_id uuid, out_email citext, out_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  u users%ROWTYPE;
BEGIN
  SELECT * INTO u FROM users WHERE email = p_email AND disabled_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE password_resets SET used_at = now() WHERE user_id = u.id AND used_at IS NULL;
  INSERT INTO password_resets (user_id, token_hash, expires_at)
  VALUES (u.id, p_token_hash, now() + interval '1 hour');
  RETURN QUERY SELECT u.id, u.email, u.name;
END $$;

-- Define a nova senha. true = sucesso; false = token inválido/expirado/já usado.
-- Revoga todas as sessões do usuário.
CREATE FUNCTION auth_reset_password(p_token_hash text, p_new_password_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r password_resets%ROWTYPE;
BEGIN
  SELECT * INTO r FROM password_resets
   WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE users SET password_hash = p_new_password_hash WHERE id = r.user_id AND disabled_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE password_resets SET used_at = now() WHERE id = r.id;
  UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = r.user_id AND revoked_at IS NULL;
  RETURN true;
END $$;

-- Limpeza periódica (worker, 1x/dia)
CREATE FUNCTION auth_purge_expired() RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH a AS (DELETE FROM refresh_tokens
              WHERE expires_at < now() - interval '7 days'
                 OR revoked_at < now() - interval '7 days' RETURNING 1),
       b AS (DELETE FROM password_resets
              WHERE expires_at < now() - interval '1 day' RETURNING 1)
  SELECT (SELECT count(*) FROM a) + (SELECT count(*) FROM b)
$$;

-- ---------- permissões ----------
REVOKE EXECUTE ON FUNCTION auth_issue_refresh(uuid, uuid, text, interval),
                           auth_rotate_refresh(text, text, interval),
                           auth_revoke_refresh(text),
                           auth_revoke_all_refresh(uuid),
                           auth_request_password_reset(citext, text),
                           auth_reset_password(text, text),
                           auth_purge_expired() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_issue_refresh(uuid, uuid, text, interval),
                          auth_rotate_refresh(text, text, interval),
                          auth_revoke_refresh(text),
                          auth_revoke_all_refresh(uuid),
                          auth_request_password_reset(citext, text),
                          auth_reset_password(text, text) TO sd_app;
GRANT EXECUTE ON FUNCTION auth_purge_expired() TO sd_worker;
