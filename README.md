# Helpdesk SaaS — camada de banco (PostgreSQL 16)

Etapa 1 de 3: **banco** → API → front React.

Service desk multi-tenant (chamados, SLA com horário comercial, filas, categorias,
base de conhecimento, apontamento de horas, automações, planos e limites).

## Subir em desenvolvimento

```bash
docker compose up -d            # Postgres 16 (ou use um Postgres local)
cp .env.example .env
./db/dev-reset.sh               # drop + roles + 9 migrations + seed
PGSUPER_DB_URL=postgresql://postgres:pg_dev_pw@127.0.0.1:5432/helpdesk ./db/tests/run.sh
```

Seed: workspace `demo` — `admin@demo.local` / `demo1234` (agentes `carlos@`, `bia@`; clientes `joao@acme.local`, etc.).

## Estrutura

```
db/
  bootstrap.sh        cria banco, extensões e roles (rodar 1x, como superusuário)
  migrate.sh          aplica db/migrations/*.sql uma vez cada (tabela schema_migrations)
  migrations/         001 tipos · 002 tenancy · 003 catálogo+SLA · 004 chamados · 005 KB/outbox
                      006 triggers · 007 funções · 008 RLS+grants · 009 FKs deferíveis+delete_tenant
  seed/dev.sql        dados de demonstração
  tests/              suíte SQL (60 asserções) que roda como sd_app/sd_worker de verdade
```

## Segurança multi-tenant (o ponto mais importante)

Três camadas independentes — qualquer uma sozinha já barra vazamento entre clientes:

1. **RLS** em todas as tabelas: `tenant_id = app_tenant_id()`. Sem contexto → nenhuma linha (falha fechada).
2. **FKs compostas** `(tenant_id, x_id)`: um chamado não consegue apontar para categoria, status ou usuário de outro tenant.
3. **Roles**: a API usa `sd_app` (sem BYPASSRLS, sem acesso a `password_hash`); o dono do schema só roda migrations.

**Contrato com a API** — em *toda transação*:

```ts
await client.query('BEGIN');
await client.query('SELECT app_set_context($1, $2)', [tenantId, userId]); // vale só nesta transação
// ... queries normais, sem WHERE tenant_id ...
await client.query('COMMIT');
```

Papéis dentro do tenant (`admin`, `agent`, `requester`) também são aplicados pela RLS:
cliente só vê os próprios chamados e nunca notas internas, auditoria ou cronômetros de SLA.

| Role | Uso | RLS |
|---|---|---|
| `sd_owner` | migrations e funções `SECURITY DEFINER` | ignora |
| `sd_app` | API HTTP | **aplicada** |
| `sd_worker` | fila de e-mail, SLA, webhooks de cobrança | ignora (grants mínimos) |

## Regras que já moram no banco

- Numeração sequencial de chamados **por tenant**; defaults de status/prioridade/fila/organização.
- **SLA**: dois cronômetros por chamado (primeira resposta e resolução) em minutos úteis (faixas semanais + feriados);
  pausa em status como "Aguardando cliente", recálculo ao mudar prioridade, reabertura. `sla_mark_breaches()` marca estouros (chamar a cada minuto pelo worker). View `v_ticket_sla`.
- Resposta do cliente tira o chamado de "Aguardando cliente"/"Resolvido".
- **Auditoria** somente-inserção (`ticket_events`) e **outbox transacional** de e-mail (`email_outbox`).
- **Planos**: limite de agentes e de chamados/mês; tenant suspenso não abre chamados.
- Cadastro self-service (`signup_tenant`), convites (`accept_invitation`), login (`auth_*`), `delete_tenant` (LGPD).

## Decisões e limitações conhecidas

- Ao retomar um SLA pausado, o prazo é empurrado pelo tempo corrido de pausa (não em minutos úteis).
- `password_hash`: gere com bcrypt/argon2 na API. O seed usa bcrypt (`$2a$`).
- Busca textual (`portuguese`) e trigram em `tickets.subject`; sem `unaccent` aplicado ainda.
- Não há tabela de campos customizados (usa-se `tickets.custom_fields jsonb`), nem caixas de e-mail de entrada, nem CMDB/field service — ficam para depois do MVP.
- Testado em PostgreSQL 16.15 local. O `docker-compose.yml` não foi executado neste ambiente.

## Próximas etapas

2. **API** (Node/NestJS ou Fastify): auth (JWT + `auth_*`), middleware que abre transação e chama `app_set_context`, endpoints de chamados/mensagens/anexos (S3), worker (outbox + `sla_mark_breaches`), webhooks de cobrança.
3. **Front React**: portal do cliente + painel do atendente (fila, detalhe do chamado, SLA, KB, relatórios).
