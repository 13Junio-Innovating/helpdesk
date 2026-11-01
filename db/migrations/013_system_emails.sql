-- 013: e-mails de sistema (convite e redefinição de senha) pela mesma outbox transacional
--
-- Por que migration: sd_app não tem INSERT em email_outbox (008), e a recuperação de senha não
-- pertence a nenhum tenant (email_outbox.tenant_id era NOT NULL). Sem isto a API teria de mandar
-- esses e-mails por SMTP direto, fora da transação e fora da fila com retentativa do worker.
--
-- As funções só enfileiram e-mail para um convite/pedido de reset que ACABOU de ser criado: o token
-- em texto claro precisa bater com o hash guardado. Assim sd_app não vira um disparador de e-mails
-- arbitrários. O token vai no payload só até o envio (o worker o remove depois de enviar).

ALTER TABLE email_outbox ALTER COLUMN tenant_id DROP NOT NULL;   -- NULL = e-mail de conta (sem tenant)

CREATE FUNCTION enqueue_invitation_email(p_invitation uuid, p_token text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_inv     invitations%ROWTYPE;
  v_tenant  text;
  v_inviter text;
  v_id      bigint;
BEGIN
  IF NOT app_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_inv FROM invitations
   WHERE id = p_invitation AND tenant_id = app_tenant_id()
     AND token_hash = encode(digest(p_token, 'sha256'), 'hex')
     AND accepted_at IS NULL AND expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation_invalid_or_expired' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT name INTO v_tenant  FROM tenants WHERE id = v_inv.tenant_id;
  SELECT name INTO v_inviter FROM users   WHERE id = v_inv.invited_by;
  INSERT INTO email_outbox (tenant_id, to_email, template, payload)
  VALUES (v_inv.tenant_id, v_inv.email, 'invitation',
          jsonb_build_object('invitation_id', v_inv.id, 'token', p_token, 'tenant_name', v_tenant,
                             'role', v_inv.role, 'invited_by', v_inviter, 'expires_at', v_inv.expires_at))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Chamada logo após auth_request_password_reset (sem contexto de tenant). Devolve false se o token
-- não corresponde a um pedido válido e ainda não enfileirado.
CREATE FUNCTION enqueue_password_reset_email(p_token text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r password_resets%ROWTYPE;
  u users%ROWTYPE;
BEGIN
  SELECT * INTO r FROM password_resets
   WHERE token_hash = encode(digest(p_token, 'sha256'), 'hex') AND used_at IS NULL AND expires_at > now();
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM email_outbox WHERE template = 'password_reset' AND payload->>'reset_id' = r.id::text) THEN
    RETURN false;
  END IF;

  SELECT * INTO u FROM users WHERE id = r.user_id AND disabled_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO email_outbox (tenant_id, to_email, template, payload)
  VALUES (NULL, u.email, 'password_reset',
          jsonb_build_object('reset_id', r.id, 'token', p_token, 'name', u.name, 'expires_at', r.expires_at));
  RETURN true;
END $$;

REVOKE EXECUTE ON FUNCTION enqueue_invitation_email(uuid, text), enqueue_password_reset_email(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION enqueue_invitation_email(uuid, text), enqueue_password_reset_email(text) TO sd_app;
