-- 010: sessões (refresh token com rotação) e redefinição de senha
--
-- Por que no banco: refresh e reset acontecem ANTES de existir contexto de tenant e o
-- sd_app não tem onde gravar estado. Sem estado não há logout real nem detecção de
-- reuso de refresh token roubado. Guardamos só o hash SHA-256 dos tokens.
-- Acesso exclusivamente via funções SECURITY DEFINER (mesmo padrão dos auth_*).

CREATE TABLE auth_refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid        NOT NULL,                 -- cadeia de rotação (um login = uma família)
  user_id     uuid        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash  text        NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  rotated_at  timestamptz,                          -- já trocado por um sucessor
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_family ON auth_refresh_tokens (family_id);
CREATE INDEX idx_refresh_user   ON auth_refresh_tokens (user_id) WHERE revoked_at IS NULL;

CREATE TABLE password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text        NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_reset_user ON password_reset_tokens (user_id) WHERE used_at IS NULL;

ALTER TABLE auth_refresh_tokens   ENABLE ROW LEVEL SECURITY;   -- sem policy: só funções DEFINER
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;

-- E-mail de redefinição de senha não pertence a um tenant (identidade é global).
ALTER TABLE email_outbox ALTER COLUMN tenant_id DROP NOT NULL;

-- Usuário pode usar o tenant? (ativo + membership ativo)
CREATE FUNCTION auth_can_access(p_user uuid, p_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.user_id = p_user AND m.tenant_id = p_tenant AND m.active AND u.disabled_at IS NULL)
$$;

-- Novo login: cria a primeira linha de uma família.
CREATE FUNCTION auth_session_create(p_user uuid, p_tenant uuid, p_token_hash text, p_ttl interval)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_family uuid := gen_random_uuid();
BEGIN
  IF NOT auth_can_access(p_user, p_tenant) THEN
    RAISE EXCEPTION 'session_invalid' USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  INSERT INTO auth_refresh_tokens (family_id, user_id, tenant_id, token_hash, expires_at)
  VALUES (v_family, p_user, p_tenant, p_token_hash, now() + p_ttl);
  RETURN v_family;
END $$;

-- Rotação. Não lança erro em reuso/invalidade: a revogação da família precisa ser COMMITADA.
--   status = 'ok'      -> novo token gravado; devolve user/tenant
--   status = 'invalid' -> token desconhecido, expirado, revogado, ou acesso perdido
--   status = 'reused'  -> token já rotacionado foi reapresentado: família inteira revogada
CREATE FUNCTION auth_session_rotate(p_old_hash text, p_new_hash text, p_ttl interval)
RETURNS TABLE (status text, user_id uuid, tenant_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r auth_refresh_tokens%ROWTYPE;
BEGIN
  SELECT * INTO r FROM auth_refresh_tokens t WHERE t.token_hash = p_old_hash FOR UPDATE;
  IF NOT FOUND OR r.revoked_at IS NOT NULL OR r.expires_at <= now() THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;
  IF r.rotated_at IS NOT NULL THEN
    UPDATE auth_refresh_tokens t SET revoked_at = now()
     WHERE t.family_id = r.family_id AND t.revoked_at IS NULL;
    RETURN QUERY SELECT 'reused'::text, r.user_id, r.tenant_id;
    RETURN;
  END IF;
  IF NOT auth_can_access(r.user_id, r.tenant_id) THEN
    UPDATE auth_refresh_tokens t SET revoked_at = now()
     WHERE t.family_id = r.family_id AND t.revoked_at IS NULL;
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  UPDATE auth_refresh_tokens t SET rotated_at = now() WHERE t.id = r.id;
  INSERT INTO auth_refresh_tokens (family_id, user_id, tenant_id, token_hash, expires_at)
  VALUES (r.family_id, r.user_id, r.tenant_id, p_new_hash, now() + p_ttl);
  RETURN QUERY SELECT 'ok'::text, r.user_id, r.tenant_id;
END $$;

-- Logout: revoga a família do token apresentado (idempotente).
CREATE FUNCTION auth_session_revoke(p_token_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE auth_refresh_tokens SET revoked_at = now()
   WHERE revoked_at IS NULL
     AND family_id = (SELECT family_id FROM auth_refresh_tokens WHERE token_hash = p_token_hash)
$$;

-- Pedido de redefinição. Só gera token para usuário existente e ativo; caso contrário não faz nada
-- (a API responde igual nos dois casos). Invalida pedidos anteriores e enfileira o e-mail.
-- O token em claro vai no payload da outbox (acessível só pelo worker), que o descarta após o envio.
CREATE FUNCTION auth_reset_create(p_email citext, p_token_hash text, p_token text, p_ttl interval)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user users%ROWTYPE;
BEGIN
  SELECT * INTO v_user FROM users WHERE email = p_email AND disabled_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE password_reset_tokens SET used_at = now() WHERE user_id = v_user.id AND used_at IS NULL;
  INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
  VALUES (v_user.id, p_token_hash, now() + p_ttl);
  INSERT INTO email_outbox (tenant_id, to_email, template, payload)
  VALUES (NULL, v_user.email, 'password_reset',
          jsonb_build_object('name', v_user.name, 'token', p_token));
  RETURN true;
END $$;

-- Consome o token (uso único), troca a senha e derruba todas as sessões do usuário.
CREATE FUNCTION auth_reset_consume(p_token_hash text, p_password_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r password_reset_tokens%ROWTYPE;
BEGIN
  SELECT * INTO r FROM password_reset_tokens
   WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reset_token_invalid' USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE password_reset_tokens SET used_at = now() WHERE id = r.id;
  UPDATE users SET password_hash = p_password_hash WHERE id = r.user_id;
  UPDATE auth_refresh_tokens SET revoked_at = now() WHERE user_id = r.user_id AND revoked_at IS NULL;
  RETURN r.user_id;
END $$;

REVOKE ALL ON auth_refresh_tokens, password_reset_tokens FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION auth_can_access(uuid, uuid),
                           auth_session_create(uuid, uuid, text, interval),
                           auth_session_rotate(text, text, interval),
                           auth_session_revoke(text),
                           auth_reset_create(citext, text, text, interval),
                           auth_reset_consume(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_can_access(uuid, uuid),
                          auth_session_create(uuid, uuid, text, interval),
                          auth_session_rotate(text, text, interval),
                          auth_session_revoke(text),
                          auth_reset_create(citext, text, text, interval),
                          auth_reset_consume(text, text) TO sd_app;
