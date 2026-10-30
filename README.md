# Helpdesk SaaS

Etapas: **banco** (PostgreSQL 16, pronto) → **API** (NestJS, em andamento) → front React.

Service desk multi-tenant (chamados, SLA com horário comercial, filas, categorias,
base de conhecimento, apontamento de horas, automações, planos e limites).

## Subir em desenvolvimento

```bash
docker compose up -d            # Postgres 16 (ou use um Postgres local)
cp .env.example .env
./db/dev-reset.sh               # drop + roles + migrations + seed
npm run test:db                 # suíte SQL do banco

npm install                     # requer npm >= 11 (bug do npm 10 com workspaces/peer deps)
npm run build -w shared
npm run start:dev -w api        # http://localhost:3000/api/v1 · Swagger em http://localhost:3000/docs
npm run test:api                # unitários + e2e da API contra o Postgres real (usa o seed)
npm run lint
```

Seed: workspace `demo` — `admin@demo.local` / `demo1234` (agentes `carlos@`, `bia@`; clientes `joao@acme.local`, etc.).

## Estrutura

```
shared/               tipos/enums compartilhados API ⇄ front (@helpdesk/shared)
api/                  NestJS 12 (ESM) + pg puro
  src/common/db/        DbService: withTenant() / withoutTenant() — único caminho para o banco
  src/common/errors/    filtro global + mapeamento SQLSTATE → { code, message }
  src/common/auth/      JwtAuthGuard global, @Public, @Roles, @AllowPreTenant, @CurrentTenantUser
  src/common/throttle/  rate limit (geral por IP; login/signup/forgot por IP e por e-mail)
  src/auth/             login em 2 etapas, refresh com rotação, signup, convite, reset de senha
  src/catalog/          leitura de status/prioridades/categorias/filas (CRUD na fase 3)
  src/health/           /health (banco) e /health/ready (migrations exigidas)
  test/                 e2e (vitest + supertest) contra o banco de dev
db/
  bootstrap.sh        cria banco, extensões e roles (rodar 1x, como superusuário)
  migrate.sh          aplica db/migrations/*.sql uma vez cada (tabela schema_migrations)
  migrations/         001 tipos · 002 tenancy · 003 catálogo+SLA · 004 chamados · 005 KB/outbox
                      006 triggers · 007 funções · 008 RLS+grants · 009 FKs deferíveis+delete_tenant
                      010 sessões (refresh com rotação) + reset de senha
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

## API — contrato e decisões

- **Toda** query de dados de tenant roda em `DbService.withTenant(ctx, fn)`: `BEGIN` → `app_set_context` (LOCAL) →
  revalida no banco `app_role()` e `users.disabled_at` → `fn` → `COMMIT`/`ROLLBACK` → conexão liberada (descartada se o ROLLBACK falhar).
  Usuário desativado ou com membership inativo recebe 401 `session_invalid` na requisição seguinte, mesmo com JWT válido.
  O callback recebe só `query` (não consegue liberar/reter a conexão). Optei por chamadas explícitas em vez de um interceptor `@Tx()`:
  o fim da transação fica visível no código e não depende do ciclo do Observable.
- O **papel no JWT serve só para a UI** e para `@Roles` como primeira barreira; a autorização real é a RLS.
- **Sessão**: access token JWT HS256 de 15 min (em memória no front) + refresh opaco em cookie `hd_rt`
  (`HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth`). Rotação a cada uso; reapresentar um refresh já usado revoga a
  família inteira (detecção de roubo). Só o SHA-256 dos tokens fica no banco (migration 010, acessada via funções SECURITY DEFINER).
  Duas abas renovando ao mesmo tempo disparam a detecção de reuso: o front deve serializar o refresh.
- **Login em 2 etapas**: com mais de um workspace, `/auth/login` devolve um token "pré-tenant" (5 min) que só serve para
  `/auth/select-tenant`. O tempo de resposta não revela se o e-mail existe (bcrypt contra hash fictício).
- **Convite para e-mail que já tem conta** exige a senha atual dessa conta (conferida na mesma transação; se falhar, o convite
  não é consumido). Sem isso, quem tivesse o link entraria na conta de outra pessoa.
- **Reset de senha**: resposta idêntica exista ou não o e-mail; token de uso único (1 h), pedido novo invalida o anterior,
  e o reset derruba todas as sessões. O e-mail sai pela `email_outbox` (agora com `tenant_id` opcional); o worker (fase 4)
  deve apagar o token do payload depois de enviar.
- **Rate limit** em memória (por instância): geral 300 req/min por IP; login/signup/accept-invite/forgot/reset com janelas
  de 15 min por IP (30) e por e-mail (10). Com várias instâncias, trocar o storage por Redis.
- Stack: NestJS 12 (ESM), vitest (template oficial do Nest 12), pg sem ORM, zod para validar o env, pino com `requestId`
  e redação de `authorization`/`cookie`/senhas/tokens.

## Próximas etapas

2. **API** (Node/NestJS ou Fastify): auth (JWT + `auth_*`), middleware que abre transação e chama `app_set_context`, endpoints de chamados/mensagens/anexos (S3), worker (outbox + `sla_mark_breaches`), webhooks de cobrança.
3. **Front React**: portal do cliente + painel do atendente (fila, detalhe do chamado, SLA, KB, relatórios).
