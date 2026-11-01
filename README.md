# Helpdesk SaaS

Etapas: **banco** (PostgreSQL 16, pronto) → **API** NestJS (`api/`, em andamento) → front React.

Service desk multi-tenant (chamados, SLA com horário comercial, filas, categorias,
base de conhecimento, apontamento de horas, automações, planos e limites).

## Subir em desenvolvimento

```bash
docker compose up -d            # Postgres 16 + Mailpit (ou use serviços locais)
cp .env.example .env
./db/dev-reset.sh               # drop + roles + migrations + seed
PGSUPER_DB_URL=postgresql://postgres:pg_dev_pw@127.0.0.1:5432/helpdesk ./db/tests/run.sh
```

API (precisa de Node 22+):

```bash
npm install                     # workspaces da raiz (api/)
npm run api:dev                 # http://localhost:3000/api/v1  ·  Swagger em http://localhost:3000/docs
npm run worker:dev              # worker (outbox, SLA, automações) — e-mails em http://localhost:8025
npm run api:test                # unitários + e2e (Postgres e Mailpit reais; rode ./db/dev-reset.sh antes)
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
                      013 e-mails de sistema (convite e reset de senha) na outbox · 014 estado do worker
  seed/dev.sql        dados de demonstração
  tests/              suíte SQL (125 asserções) que roda como sd_app/sd_worker de verdade
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
  catalog/         filas (+membros), categorias, prioridades, status, horário comercial (+faixas, feriados),
                   políticas de SLA, automações — CRUD genérico guiado por catalog.specs.ts
  users/           membros, agentes, convites, organizações (clientes)
  kb/              base de conhecimento (busca full-text, slug automático)
  reports/         GET /reports/overview -> report_overview()
  macros/          respostas prontas (com render de variáveis) e visões salvas
  tenants/         GET/PATCH /tenant: plano, uso do mês, trial
  worker/          processo separado (worker.main.ts) com a conexão sd_worker — nunca importado pelo AppModule
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

**Demais rotas** (todas sob `/api/v1`, todas sob `withTenant`):

| Área | Rotas |
|---|---|
| Catálogo | `GET/POST /{queues,categories,priorities,statuses,business-hours,sla-policies,automation-rules}`, `GET/PATCH/DELETE /…/:id`; `GET/PUT /queues/:id/members`; `GET /business-hours/:id/schedule`, `PUT /business-hours/:id/slots`, `POST /business-hours/:id/holidays`, `DELETE /business-hours/:id/holidays/:data` |
| Equipe | `GET /members` (cursor; `role`, `group=staff`, `active`, `organization`, `q`), `PATCH /members/:userId`, `GET /agents`, `GET/POST /invitations`, `DELETE /invitations/:id` |
| Clientes | `GET/POST /organizations`, `GET/PATCH/DELETE /organizations/:id` |
| Auth | `POST /auth/accept-invite`, `POST /auth/forgot-password`, `POST /auth/reset-password` |
| KB | `GET /kb` (cursor; com `q` ordena por relevância), `GET /kb/:slug`, `POST /kb`, `PATCH/DELETE /kb/:id` |
| Relatórios | `GET /reports/overview?from=&to=` (máx. 366 dias) |
| Macros | `GET/POST /macros`, `PATCH/DELETE /macros/:id`, `POST /macros/:id/render {ticketId}`, `GET /macros/variables` |
| Visões | `GET/POST /saved-views`, `PATCH/DELETE /saved-views/:id` (o GET inclui 4 visões prontas `builtin:*`) |
| Workspace | `GET /tenant` (plano, uso de agentes e de chamados no mês, trial; assinatura só para admin), `PATCH /tenant` |

**Automações** (formato validado na API e executado pelo worker):

```json
{ "event": "ticket_created",
  "conditions": [{ "field": "priority.name", "op": "eq", "value": "Urgente" },
                 { "field": "tags", "op": "contains", "value": "vip" },
                 { "field": "category.id", "op": "in", "value": ["<uuid>", "<uuid>"] }],
  "actions": [{ "type": "assign_queue", "queue_id": "<uuid>" }, { "type": "assign_agent", "user_id": "<uuid>" },
              { "type": "set_priority", "priority_id": "<uuid>" }, { "type": "add_tag", "value": "plantao" },
              { "type": "notify_staff" }] }
```

Campos: `subject, description, channel, tags, priority.{id,name}, status.{id,name,kind}, category.{id,name}, queue.{id,name},
requester.email, organization.{id,name}`. Operadores: `eq`, `in`, `contains` (sem diferenciar maiúsculas). Todas as condições
precisam valer (E). As referências das ações são conferidas no workspace ao salvar.

## Worker — `api/src/worker`

Processo separado (`npm run worker` / `worker:dev`), conectado como **`sd_worker`**. O `AppModule` (HTTP) não importa
o módulo do worker, então nenhuma rota de usuário alcança essa conexão (há teste disso).

| Job | Quando | O quê |
|---|---|---|
| outbox | a cada `OUTBOX_POLL_MS` (5 s) | envia `email_outbox` por SMTP (nodemailer). Reserva com `FOR UPDATE SKIP LOCKED` + prazo de 5 min (`sending`); `sent` (e o token de convite/reset sai do payload) ou `failed` com `attempts+1`, `last_error` e backoff exponencial (30 s, 60 s, 120 s... até 1 h); desiste após `OUTBOX_MAX_ATTEMPTS` (5) |
| sla | `SLA_CRON` (todo minuto) | `sla_mark_breaches()`; depois o alerta de 80%: e-mail para o responsável + evento `sla_warning`, uma vez por prazo (`warned_at`) |
| automações | a cada `AUTOMATIONS_POLL_MS` (5 s) | avalia `automation_rules` sobre os eventos novos (`created`, mudanças, `sla_warning`, `sla_breached`) |
| limpeza | `PURGE_CRON` (diária, 04:17) | `auth_purge_expired()` e histórico do avaliador com mais de 7 dias |

Templates: `ticket_created`, `ticket_reply` (só resposta pública), `invitation`, `password_reset`, `sla_warning`,
`staff_notification`. Os links usam `APP_URL` (`/tickets/:id`, `/accept-invite?token=`, `/reset-password?token=`).

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
- **Migration 013 (e-mails de sistema).** `sd_app` não grava na `email_outbox` e a recuperação de senha não tem
  tenant. As funções `enqueue_invitation_email` e `enqueue_password_reset_email` só enfileiram e-mail para um convite
  ou pedido de reset que acabou de ser criado (o token precisa bater com o hash guardado), então a API não vira
  disparador de e-mails arbitrários. O token vai no payload até o envio; o worker vai apagá-lo depois de enviar.
- **Convite também serve de login** (como um link mágico): chegou no e-mail da pessoa, é de uso único e vale 7 dias.
  Se a pessoa já tem conta, a senha dela é mantida (a digitada no aceite é ignorada, regra do `accept_invitation`).
  Um convite novo para o mesmo e-mail substitui os pendentes.
- **O limite de agentes é conferido pelo banco no aceite do convite** (e na promoção de papel), não na criação do
  convite: a API não reimplementa a regra. O admin vê o uso em `GET /tenant` antes de convidar.
- **Escrita no catálogo sem `@Roles`**: a RLS decide e a API traduz (INSERT barrado → 42501 → 403; UPDATE/DELETE
  barrado → 0 linhas → 403 se o registro é visível, 404 se não é).
- **Padrões únicos** (`is_default` de status, prioridade, SLA): marcar um novo desmarca o anterior na mesma transação.
  Status e prioridade sempre precisam ter um padrão (`422 default_required`).
- **Apagar algo em uso** (FK) responde `409 in_use`, em vez do `422 invalid_reference` de quando se aponta para algo
  que não existe.
- **Automações exigem o recurso do plano** (`plans.features.automations`): no Starter, `402 plan_feature_unavailable`.
- **Listas do catálogo não são paginadas** (são pequenas por natureza). Membros, organizações, KB e chamados são.
- Mudar SLA, prioridade-padrão ou horário comercial **não recalcula** os prazos de chamados já abertos (só os novos e
  os que mudarem de prioridade), que é o comportamento dos triggers da etapa 1.
- **Migration 014 (estado do worker).** O avaliador de automações precisa lembrar quais eventos já avaliou, e o
  alerta de SLA, quais prazos já avisou; o `sd_worker` não cria tabela nem altera `sla_timers`. Entram
  `automation_runs` (PK = evento: a própria PK é a trava entre instâncias) e `sla_timers.warned_at` (zerado por
  trigger quando o prazo muda). Não usei um cursor por id porque ids de identity podem ser confirmados fora de
  ordem por transações concorrentes, e um cursor pularia eventos.
- **Automações sem cascata**: os eventos gerados pelas ações de uma automação são marcados `skipped` na mesma
  transação, então uma regra nunca dispara outra. Todas as regras do evento são avaliadas sobre o mesmo estado do
  chamado; para o mesmo campo, a última regra (por `position`) vence. Uma transação por evento: ação inválida no
  momento da execução (ex.: agente desativado) vira `error` registrado e não trava a fila (não há nova tentativa).
- **`notify_staff`** avisa o responsável; sem responsável, os membros da fila; sem fila (ou fila vazia), toda a equipe.
- **E-mail é entregue "pelo menos uma vez"**: se o worker cair entre o SMTP aceitar e o `UPDATE sent`, o e-mail
  volta depois do prazo de reserva. O `Message-ID` é estável por linha da outbox, o que ajuda o destino a deduplicar.
- **Alerta de 80%** usa tempo corrido desde a abertura (aproximação do prazo em minutos úteis).
- **Pacote `shared/`** (tipos compartilhados com o front) fica para a fase do front, quando houver quem consuma.
- Em produção o boot falha se o `JWT_SECRET` for o de exemplo ou se `COOKIE_SECURE=false`.

## Próximas etapas

2. **API** — fases 1 (esqueleto, `DbService`, erros, health, auth), 2 (chamados) e 3 (catálogo, equipe, convites, KB,
   relatórios, macros, visões, workspace) e 4 (worker) prontas. Falta: anexos e cobrança (fase 7).
3. **Front React**: portal do cliente + painel do atendente (fila, detalhe do chamado, SLA, KB, relatórios).
