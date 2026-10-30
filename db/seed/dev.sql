-- Dados de DESENVOLVIMENTO (não rodar em produção). Rodar como sd_owner ou superusuário.
--   psql "$DATABASE_URL_OWNER" -v ON_ERROR_STOP=1 -f db/seed/dev.sql
--
-- Logins (senha de todos: demo1234, hash bcrypt):
--   admin@demo.local   (admin)      carlos@demo.local (agente)    bia@demo.local (agente)
--   joao@acme.local    (cliente)    maria@acme.local  (cliente)   pedro@globex.local (cliente)

DO $$
DECLARE
  v_hash   text := crypt('demo1234', gen_salt('bf', 10));
  v_t      uuid;
  v_admin  uuid;
  v_org1   uuid;
  v_org2   uuid;
  v_tk     uuid;
  v_ag     uuid;
  r        record;
  u        record;
BEGIN
  IF EXISTS (SELECT 1 FROM tenants WHERE slug = 'demo') THEN
    RAISE NOTICE 'Workspace "demo" já existe; nada a fazer.';
    RETURN;
  END IF;

  SELECT out_tenant_id, out_user_id INTO v_t, v_admin
    FROM signup_tenant('Demo Suporte', 'demo', 'admin@demo.local', 'Ana Admin', v_hash);

  INSERT INTO organizations (tenant_id, name, document) VALUES (v_t, 'ACME Indústria', '12.345.678/0001-90')
    RETURNING id INTO v_org1;
  INSERT INTO organizations (tenant_id, name) VALUES (v_t, 'Globex Logística') RETURNING id INTO v_org2;

  FOR u IN SELECT * FROM (VALUES
      ('carlos@demo.local', 'Carlos Souza',   'agent',     NULL::uuid),
      ('bia@demo.local',    'Beatriz Lima',   'agent',     NULL::uuid),
      ('joao@acme.local',   'João Pereira',   'requester', v_org1),
      ('maria@acme.local',  'Maria Santos',   'requester', v_org1),
      ('pedro@globex.local','Pedro Almeida',  'requester', v_org2)
    ) AS x(email, name, role, org)
  LOOP
    INSERT INTO users (email, name, password_hash) VALUES (u.email, u.name, v_hash);
    INSERT INTO memberships (tenant_id, user_id, role, organization_id)
    SELECT v_t, id, u.role::member_role, u.org FROM users WHERE email = u.email;
  END LOOP;

  INSERT INTO queue_members (tenant_id, queue_id, user_id)
  SELECT v_t, q.id, m.user_id FROM queues q, memberships m
   WHERE q.tenant_id = v_t AND m.tenant_id = v_t AND m.role IN ('admin', 'agent');

  INSERT INTO kb_articles (tenant_id, title, slug, body, status, visibility, author_id, published_at) VALUES
    (v_t, 'Como redefinir minha senha', 'redefinir-senha',
     'Na tela de login, clique em "Esqueci minha senha" e siga as instruções enviadas por e-mail.',
     'published', 'portal', v_admin, now()),
    (v_t, 'Procedimento interno: acesso remoto', 'acesso-remoto-interno',
     'Solicitar autorização do cliente antes de iniciar a sessão remota. Registrar o horário no chamado.',
     'published', 'internal', v_admin, now());

  INSERT INTO automation_rules (tenant_id, name, event, conditions, actions, position) VALUES
    (v_t, 'Urgente vai para o plantão', 'ticket_created',
     '[{"field":"priority.name","op":"eq","value":"Urgente"}]',
     '[{"type":"add_tag","value":"plantao"},{"type":"notify_staff"}]', 1);

  -- chamados: age_h = idade em horas; "reply" = agente respondeu 20 min após a abertura
  FOR r IN SELECT * FROM jsonb_to_recordset($j$[
    {"subject":"Impressora do financeiro não imprime","descr":"Aparece erro de spooler desde ontem.","requester":"joao@acme.local","category":"Incidente","priority":"Alta","status":"Em atendimento","age_h":5,"assignee":"carlos@demo.local","reply":true},
    {"subject":"Dúvida sobre emissão de relatório mensal","descr":"Onde encontro o relatório de fechamento?","requester":"maria@acme.local","category":"Dúvida","priority":"Baixa","status":"Resolvido","age_h":52,"assignee":"bia@demo.local","reply":true},
    {"subject":"Sistema fora do ar para toda a filial","descr":"Ninguém consegue acessar desde 8h.","requester":"pedro@globex.local","category":"Incidente","priority":"Urgente","status":"Em atendimento","age_h":30,"assignee":"carlos@demo.local","reply":true},
    {"subject":"Solicitação de novo usuário","descr":"Criar acesso para estagiário do comercial.","requester":"joao@acme.local","category":"Solicitação","priority":"Normal","status":"Aguardando cliente","age_h":20,"assignee":"bia@demo.local","reply":true},
    {"subject":"Lentidão ao abrir o módulo de estoque","descr":"Leva mais de 1 minuto para carregar.","requester":"maria@acme.local","category":"Incidente","priority":"Normal","status":"Novo","age_h":72,"assignee":null,"reply":false},
    {"subject":"Erro ao anexar arquivo PDF","descr":"Mensagem de tamanho excedido.","requester":"pedro@globex.local","category":"Dúvida","priority":"Normal","status":"Fechado","age_h":120,"assignee":"carlos@demo.local","reply":true},
    {"subject":"Troca de senha não chega por e-mail","descr":"Já verifiquei o spam.","requester":"joao@acme.local","category":"Incidente","priority":"Alta","status":"Novo","age_h":1,"assignee":null,"reply":false},
    {"subject":"Instalar certificado digital na estação 12","descr":"Necessário para emissão de NF-e.","requester":"maria@acme.local","category":"Solicitação","priority":"Normal","status":"Em espera","age_h":40,"assignee":"bia@demo.local","reply":true},
    {"subject":"Permissão para exportar planilhas","descr":"Meu perfil não mostra o botão exportar.","requester":"pedro@globex.local","category":"Solicitação","priority":"Baixa","status":"Novo","age_h":8,"assignee":null,"reply":false},
    {"subject":"Cobrança duplicada na fatura","descr":"Foram dois lançamentos do mesmo valor.","requester":"joao@acme.local","category":"Dúvida","priority":"Alta","status":"Resolvido","age_h":96,"assignee":"carlos@demo.local","reply":true}
  ]$j$::jsonb) AS x(subject text, descr text, requester text, category text, priority text,
                    status text, age_h int, assignee text, reply boolean)
  LOOP
    SELECT m.user_id INTO v_ag FROM memberships m JOIN users uu ON uu.id = m.user_id
     WHERE m.tenant_id = v_t AND uu.email = r.assignee;

    INSERT INTO tickets (tenant_id, subject, description, requester_id, assignee_id, category_id,
                         priority_id, channel, created_at)
    VALUES (v_t, r.subject, r.descr,
            (SELECT m.user_id FROM memberships m JOIN users uu ON uu.id = m.user_id
              WHERE m.tenant_id = v_t AND uu.email = r.requester),
            v_ag,
            (SELECT id FROM categories WHERE tenant_id = v_t AND name = r.category),
            (SELECT id FROM priorities WHERE tenant_id = v_t AND name = r.priority),
            'portal', now() - make_interval(hours => r.age_h))
    RETURNING id INTO v_tk;

    IF r.reply AND v_ag IS NOT NULL THEN
      INSERT INTO ticket_messages (tenant_id, ticket_id, author_id, kind, body, created_at)
      VALUES (v_t, v_tk, v_ag, 'public_reply', 'Olá! Já estamos analisando o seu chamado.',
              now() - make_interval(hours => r.age_h) + interval '20 minutes');
    END IF;

    IF r.status <> 'Novo' THEN
      UPDATE tickets SET status_id = (SELECT id FROM statuses WHERE tenant_id = v_t AND name = r.status)
       WHERE id = v_tk;
    END IF;
  END LOOP;

  PERFORM sla_mark_breaches();
  RAISE NOTICE 'Seed ok: workspace "demo" (login admin@demo.local / demo1234)';
END $$;
