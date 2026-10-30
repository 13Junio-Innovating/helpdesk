# Helpdesk SaaS

Etapas: **banco** (PostgreSQL 16, pronto) → **API** (NestJS, em andamento) → front React.

Service desk multi-tenant (chamados, SLA com horário comercial, filas, categorias,
base de conhecimento, apontamento de horas, automações, planos e limites).

## Ver rodando na sua máquina

Pré-requisitos: Docker, Node 22+, cliente `psql` (os scripts de `db/` usam).

```bash
git clone https://github.com/13Junio-Innovating/helpdesk && cd helpdesk
git checkout feat/fase-3-catalogo-equipe-kb     # ou a branch da fase mais recente
docker compose up -d && cp .env.example .env && ./db/dev-reset.sh
npx npm@11 install && npm run build -w shared
npm run start:dev -w api            # API
npm run build -w api && npm run start:worker -w api   # worker (outro terminal)
```

Abra **http://localhost:3000/docs** (Swagger) e **http://localhost:8025** (Mailpit: todos os e-mails enviados em dev). Para testar, clique em `POST /api/v1/auth/login`, envie
`{"email":"admin@demo.local","password":"demo1234"}`, copie o `accessToken`, clique em **Authorize** e cole o token.
O front React (http://localhost:5173) entra nas fases 5 e 6.

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
  src/tickets/          chamados, mensagens, ações em lote, apontamento de horas
  src/catalog/          CRUD de filas, categorias, prioridades, status, horário comercial, SLA e automações
  src/team/             membros, convites, organizações, /agents
  src/kb/               base de conhecimento
  src/reports/          /reports/overview (SQL agregado)
  src/tenants/          /tenant (plano, uso, assinatura)
  src/worker/           processo separado (sd_worker): SLA, outbox de e-mail, automações, alertas
  src/health/           /health (banco) e /health/ready (migrations exigidas)
  test/                 e2e (vitest + supertest) contra o banco de dev
db/
  bootstrap.sh        cria banco, extensões e roles (rodar 1x, como superusuário)
  migrate.sh          aplica db/migrations/*.sql uma vez cada (tabela schema_migrations)
  migrations/         001 tipos · 002 tenancy · 003 catálogo+SLA · 004 chamados · 005 KB/outbox
                      006 triggers · 007 funções · 008 RLS+grants · 009 FKs deferíveis+delete_tenant
                      010 sessões (refresh com rotação) + reset de senha
                      011 e-mail de convite pela outbox · 012 estado do worker (automation_runs, sla_alerts)
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
- **Chamados**:
  - **Listagem**: `GET /tickets` usa paginação por cursor (keyset), com `limit` de até 100.
    - O cursor guarda os valores de ordenação como texto vindo do próprio Postgres; um `Date` do JS perderia os microssegundos e repetiria ou pularia linhas.
    - Nomes de status, prioridade e pessoas e o SLA agregado vêm no mesmo SELECT, sem N+1.
    - Filtros: `status` (IDs e/ou tipos separados por vírgula), `assignee=me|none|<id>`, `queue`, `category`, `priority`, `organization`, `requester`, `sla=breached|running|paused`, `tag`, `createdFrom/To`, `sort=updated|created|priority|due`.
    - `q`: busca full-text em português, com fallback `ILIKE` (índice trigram) e `#número`.
  - **SLA na resposta**: só a equipe recebe; para o cliente vem `null`, porque a RLS de `sla_timers` não devolve linhas. O resumo segue a ordem breached > running > paused > met_late > met. `sla=breached` olha o prazo em tempo real, sem esperar o worker.
  - **PATCH e lote**: um único `UPDATE` só com colunas de uma lista fixa, a mesma dos GRANTs; os triggers rodam uma vez para o conjunto de mudanças. O lote é tudo ou nada; IDs inexistentes ou de outro tenant voltam em `skipped`. Quando o UPDATE não afeta nenhuma linha: 404 se o chamado não é visível, 403 se é visível mas a RLS não deixa alterar.
  - **Cliente**: ao abrir chamado, a API descarta organização, canal e tags, além do que o banco já ignora (status, prioridade, fila, responsável). Abrir em nome de outra pessoa dá 403.
  - **Horas**: só o autor ou um admin remove um apontamento. Essa é uma regra da API: a RLS libera qualquer agente.
- **Catálogo**:
  - Leitura de status, prioridades, categorias e filas: todos os papéis. Horário comercial, SLA e automações: só a equipe lê. Escrita: só admin.
  - O `@Roles` é a primeira barreira; a RLS decide. Há teste provando que a RLS barra o agente mesmo sem o guard.
  - Padrão (`isDefault`) é exclusivo. Status e prioridade padrão não podem ser removidos nem desmarcados (409), porque o banco depende deles para novos chamados.
  - Registro em uso → 409 `in_use`.
  - Mudar uma política de SLA não recalcula chamados já abertos.
- **Formato das automações** (validado na API; o worker avalia na fase 4). Todas as condições precisam valer (E).
  - `conditions`: `[{ "field": "priority.name", "op": "eq|in|contains", "value": "Urgente" | ["Alta","Urgente"] }]`.
    Campos: `subject`, `description`, `channel`, `tags`, `priority.id|name`, `status.id|name|kind`, `category.id|name`, `queue.id`, `organization.id`, `assignee.id`, `requester.id`.
  - `actions`: `assign_queue {queueId}`, `assign_agent {userId}`, `set_priority {priorityId}`, `add_tag {value}`, `notify_staff`.
- **Convites**:
  - O token só existe em claro no e-mail (enfileirado pela função `enqueue_invitation_email`, migration 011). Nunca volta na resposta, nem para o admin.
  - Reenviar convite invalida o anterior. Convidar quem já é membro ativo → 409 `already_member`.
  - O limite de agentes é do banco: dá 402 ao promover ou ao aceitar o convite.
  - O workspace nunca fica sem admin ativo (409 `last_admin`).
- **KB**:
  - Slug gerado do título, único no tenant (`-2`, `-3`…) e estável ao editar o título.
  - O cliente só vê artigos publicados no portal (RLS).
  - Busca full-text em português ordenada por relevância, só a primeira página.
- **Relatórios**: período de 30 dias no fuso do workspace; "abertos" e "vencidos" são o estado atual.
- **Worker** (`npm run start:worker -w api`): processo separado, sem HTTP. Conecta como `sd_worker`, que nunca entra no AppModule.
  - **SLA** (a cada 1 min): roda `sla_mark_breaches()`.
    - Alerta "perto de vencer" quando o cronômetro passa de 80% do prazo, em tempo corrido desde a abertura. Vai uma vez por cronômetro (`sla_alerts`) para o responsável ou, sem responsável, para os admins.
    - O alerta também grava o evento `sla_warning`, que as automações enxergam.
  - **Outbox de e-mail** (a cada 5 s):
    - Reserva um lote com `FOR UPDATE SKIP LOCKED` e marca `sending` com prazo de reserva (`scheduled_at`); envia fora da transação.
    - Marca `sent`, ou `failed` com backoff exponencial (30 s · 2ⁿ, máx. 1 h). Desiste após 5 tentativas.
    - Linha presa em `sending` (worker morreu) volta quando a reserva expira.
    - O token (convite/reset) é apagado do payload ao enviar ou desistir.
    - Seguro com várias instâncias: há teste com 2 workers e 40 e-mails.
  - **Automações** (a cada 5 s):
    - Avalia eventos novos de `ticket_events` (último dia), um por transação com `SKIP LOCKED`, registrando em `automation_runs`.
    - Só roda em planos com `features.automations`.
    - Eventos gerados pelas próprias ações ficam como `skipped`: automação não dispara automação (sem loop).
    - Ação inválida desfaz só as ações (SAVEPOINT) e grava o erro.
  - Templates pt-BR com HTML escapado. Nota interna nunca vai por e-mail: o corpo do `ticket_reply` só é lido se for `public_reply`.
- Erros de validação: `{ code: 'validation_failed', details: [{ field, message }] }` em pt-BR.
- Stack: NestJS 12 (ESM), vitest (template oficial do Nest 12), pg sem ORM, zod para validar o env, pino com `requestId`
  e redação de `authorization`/`cookie`/senhas/tokens.

## Próximas etapas

2. **API** (Node/NestJS ou Fastify): auth (JWT + `auth_*`), middleware que abre transação e chama `app_set_context`, endpoints de chamados/mensagens/anexos (S3), worker (outbox + `sla_mark_breaches`), webhooks de cobrança.
3. **Front React**: portal do cliente + painel do atendente (fila, detalhe do chamado, SLA, KB, relatórios).
