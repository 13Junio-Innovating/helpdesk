-- 011: e-mail de convite pela outbox
--
-- Por que no banco: a API (sd_app) não tem acesso à email_outbox (grant intencional em 008),
-- e o e-mail precisa ser gravado na MESMA transação do convite (outbox transacional).
-- A função só enfileira para convite pendente do tenant corrente e só para admin.
-- O token em claro vai no payload (lido só pelo worker), que o descarta após o envio.

CREATE FUNCTION enqueue_invitation_email(p_invitation uuid, p_token text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_inv     invitations%ROWTYPE;
  v_tenant  text;
  v_inviter text;
BEGIN
  IF NOT app_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_inv FROM invitations
   WHERE id = p_invitation AND tenant_id = app_tenant_id() AND accepted_at IS NULL AND expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation_invalid_or_expired' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT name INTO v_tenant  FROM tenants WHERE id = v_inv.tenant_id;
  SELECT name INTO v_inviter FROM users   WHERE id = app_user_id();

  INSERT INTO email_outbox (tenant_id, to_email, template, payload)
  VALUES (v_inv.tenant_id, v_inv.email, 'invitation',
          jsonb_build_object('invitation_id', v_inv.id, 'tenant_name', v_tenant, 'inviter_name', v_inviter,
                             'role', v_inv.role, 'token', p_token, 'expires_at', v_inv.expires_at));
END $$;

REVOKE EXECUTE ON FUNCTION enqueue_invitation_email(uuid, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION enqueue_invitation_email(uuid, text) TO sd_app;
