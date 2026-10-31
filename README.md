# Helpdesk SaaS

Etapas: **banco** (PostgreSQL 16, pronto) → **API** NestJS (`api/`, em andamento) → front React.

Service desk multi-tenant (chamados, SLA com horário comercial, filas, categorias,
base de conhecimento, apontamento de horas, automações, planos e limites).

## Subir em desenvolvimento

```bash
docker compose up -d            # Postgres 16 (ou use um Postgres local)
cp .env.example .env
./db/dev-reset.sh               # drop + roles + 12 migrations + seed
PGSUPER_DB_URL=postgresql://postgres:pg_dev_pw@127.0.0.1:5432/helpdesk ./db/tests/run.sh
```

API (precisa de Node 22+):

```bash
npm install                     # workspaces da raiz (api/)
npm run api:dev                 # http://localhost:3000/api/v1  ·  Swagger em http://localhost:3000/docs
npm run api:test                # unitários + e2e (contra o Postgres real; rode ./db/dev-reset.sh antes)
```

Seed: workspace `demo` — `admin@demo.local` / `demo1234` (agentes `carlos@`, `bia@`; clientes `joao@acme.local`, etc.).

## Estrutura

```
db/
  bootstrap.sh        cria banco, extensões e roles (rodar 1x, como superusuário)
  migrate.sh          aplica db/migrations/*.sql uma vez cada (tabela schema_migrations)
  migrations/         001 tipos · 002 tenancy · 003 catálogo+SLA · 004 chamados · 005 KB/outbox
                      006 triggers · 007 funções · 008 RLS+grants · 009 FKs deferíveis+delete_tenant
                      010 refresh tokens+reset de senha · 011 macros+visões salvas · 012 relatórios
  seed/dev.sql        dados de demonstração
  tests/              suíte SQL (106 asserções) que roda como sd_app/sd_worker de verdade
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
- **Sessões**: refresh tokens com rotação e detecção de reuso (`auth_issue_refresh`, `auth_rotate_refresh` → `ok|reused|invalid`;
  reuso revoga a sessão inteira), logout, "sair de todos" e limpeza (`auth_purge_expired`, worker). Só o hash SHA-256 dos tokens é guardado.
- **Recuperação de senha**: `auth_request_password_reset` (1 h de validade, pedido novo invalida o anterior) e `auth_reset_password`
  (uso único; revoga as sessões abertas).
- **Macros** (respostas prontas) e **visões salvas** de filtros, por dono, com opção de compartilhar com a equipe.
- **Relatórios**: `report_overview(from, to)` devolve um JSON com abertos por status, SLA estourado, tempos médios, % de SLA cumprido,
  série diária, por agente/categoria/prioridade e horas apontadas — respeita a RLS (só equipe, só o próprio tenant).

## Decisões e limitações conhecidas

- Ao retomar um SLA pausado, o prazo é empurrado pelo tempo corrido de pausa (não em minutos úteis).
- `password_hash`: gere com bcrypt/argon2 na API. O seed usa bcrypt (`$2a$`).
- Busca textual (`portuguese`) e trigram em `tickets.subject`; sem `unaccent` aplicado ainda.
- Não há tabela de campos customizados (usa-se `tickets.custom_fields jsonb`), nem caixas de e-mail de entrada, nem CMDB/field service — ficam para depois do MVP.
- Tempos médios do relatório são em minutos corridos (não úteis).
- Testado em PostgreSQL 16.15 local. O `docker-compose.yml` não foi executado neste ambiente.

## API (etapa 2) — `api/`

NestJS 12 (ESM) + TypeScript estrito, `pg` sem ORM, Vitest + Supertest. Prefixo `/api/v1`.

```
api/src/
  config/          .env validado com zod (falha no boot se faltar algo)
  common/db/       DbService: withTenant / withUser / anonymous — única porta para o banco
  common/auth/     JwtAuthGuard global, RolesGuard, @Public/@Roles/@AllowPreTenant, MembershipService
  common/errors/   AllExceptionsFilter + tabela SQLSTATE → HTTP ({ code, message })
  common/http/     rate limit (geral por IP; login/cadastro por IP e por e-mail)
  health/          GET /health, GET /health/ready
  auth/            login, select-tenant, workspaces, signup, refresh, logout, logout-all, me
  tickets/         chamados, mensagens, ações em lote, apontamento de horas
api/test/          e2e contra o banco de dev (superusuário só para preparar/limpar cenários)
```

**Auth em duas etapas.** `POST /auth/login` devolve o token final quando o usuário tem um único workspace;
com vários, devolve `preTenantToken` (5 min, só serve para `/auth/workspaces`, `/auth/select-tenant` e
`/auth/logout-all`) e a lista. O access token (15 min) leva só `{sub, tid, typ}` e fica em memória no front;
o refresh vai no cookie `sd_rt` (`httpOnly; SameSite=Lax; Path=/api/v1/auth; Secure` fora de dev).

**Chamados** (`/tickets`):

| Rota | O quê |
|---|---|
| `GET /tickets` | lista paginada por cursor (`limit` ≤ 100, `cursor`). Filtros: `status` (ids, `kind` ou `unresolved`, separados por vírgula), `assignee` (`me`/`none`/id), `queue`, `category`, `priority`, `organization`, `requester`, `sla` (`breached`/`running`/`paused`), `tag`, `q` (full-text em português + trecho do assunto + `#número`), `createdFrom`/`createdTo`, `sort` (`updated`/`created`/`priority`/`due`) |
| `POST /tickets` | abre chamado. Cliente só informa `subject`, `description`, `categoryId` |
| `GET /tickets/:id` | chamado + mensagens visíveis + anexos; para a equipe também `events`, `sla` e `timeLoggedMinutes` |
| `PATCH /tickets/:id` | altera vários campos numa transação (`null` limpa; ausente não mexe) |
| `POST /tickets/:id/messages` | `{ kind: public_reply \| internal_note, body }`; devolve a mensagem e o chamado atualizado |
| `POST /tickets/bulk` | `{ ids[≤100], changes: { assigneeId, statusId, priorityId, queueId, addTags } }`, tudo ou nada |
| `POST/GET /tickets/:id/time-entries`, `DELETE /time-entries/:id` | apontamento de horas (equipe) |

O SLA vem como `sla: { first_response: {state, dueAt, minutesRemaining}, resolution: {...} }` (nomes da `v_ticket_sla`).

### Decisões

- **NestJS 12 em ESM** (padrão do `nest new` atual), com Vitest no lugar de Jest, como no template oficial.
- **Sem ORM, sem `@Tx()` por enquanto**: os serviços chamam `db.withTenant(auth, fn)` explicitamente. Fica
  visível em cada consulta qual contexto está sendo usado, e a transação sempre termina dentro do método.
- **O papel não vai no JWT.** A cada requisição o guard pergunta ao banco `app_role()` (cache de 5 s,
  `MEMBERSHIP_CACHE_MS`). Vínculo desativado ou usuário bloqueado → `401 session_invalid` em até 5 s.
- **Tempo de login uniforme**: sempre roda um `bcrypt.compare`, mesmo sem usuário (hash descartável).
  Senha errada, e-mail inexistente e conta desativada dão exatamente a mesma resposta.
- **Senha**: bcrypt (`bcryptjs`, custo 12; o seed usa 10). Mais de 72 bytes é recusado (o bcrypt truncaria).
- **CSRF no refresh**: o cookie é `SameSite=Lax` e só vale em `/api/v1/auth`; as demais rotas usam
  `Authorization: Bearer`, que o navegador não envia sozinho.
- **Trocar de workspace** (`select-tenant` com sessão aberta) revoga a sessão anterior daquele navegador.
- **Rate limit em memória** (`@nestjs/throttler`): vale por instância. Com várias instâncias, trocar para um
  storage Redis.
- **A RLS de UPDATE filtra em silêncio** (0 linhas, sem erro). Depois de um UPDATE que não afetou nada, a API
  confere se o chamado é visível: visível → `403 forbidden`; invisível → `404` (não revela que existe).
- **Cliente abrindo chamado com campos de equipe** (prioridade, responsável, status, solicitante...) leva
  `403 field_not_allowed` já na API, para dar um erro claro. O trigger do banco continua sendo a garantia
  (há teste inserindo direto como cliente).
- **O cliente não recebe dados internos** do chamado: SLA, fila, tags, campos customizados e organização ficam
  fora da resposta (a RLS já esconde SLA e organização; o resto é filtrado na API).
- **Paginação por chave** (`(ordem, id) < cursor`) com os valores guardados como texto do Postgres, para não perder
  os microssegundos dos timestamps. `sort=due` usa o próximo prazo de SLA em andamento (sem prazo vai para o fim).
- **Qualquer membro da equipe pode apagar apontamentos de horas** (é o que a policy da 008 permite). Se for
  preciso restringir ao dono ou ao admin, isso entra numa migration nova.
- **Pacote `shared/`** (tipos compartilhados com o front) fica para a fase do front, quando houver quem consuma.
- Em produção o boot falha se o `JWT_SECRET` for o de exemplo ou se `COOKIE_SECURE=false`.

## Próximas etapas

2. **API** — fases 1 (esqueleto, `DbService`, erros, health, auth) e 2 (chamados) prontas. Próximas: catálogo/equipe/KB/relatórios;
   worker (outbox, `sla_mark_breaches`, automações); anexos e cobrança.
3. **Front React**: portal do cliente + painel do atendente (fila, detalhe do chamado, SLA, KB, relatórios).
