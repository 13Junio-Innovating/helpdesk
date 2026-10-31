# Prompt para o Claude Code — API NestJS + Front React

> Como usar: coloque este projeto (pasta `helpdesk-saas`, com `db/`, `README.md`, `.env.example`, `docker-compose.yml`) na sua máquina, abra o Claude Code na raiz e cole TUDO abaixo da linha.

---

Você vai construir as **etapas 2 e 3** de um SaaS de service desk (help desk multi-tenant, no estilo Desk Manager / Freshdesk): uma **API em NestJS** e um **front em React**, em cima de um **banco PostgreSQL 16 que já está pronto e testado** (etapa 1).

## 0. Antes de escrever qualquer código

1. Leia `README.md` e TODOS os arquivos de `db/migrations/*.sql` (001 a 012), `db/seed/dev.sql` e `db/tests/test_db.sql`. O banco é a fonte da verdade: regras de negócio, segurança e SLA já moram nele. **Não reimplemente na API o que o banco já faz** (numeração, SLA, auditoria, outbox, limites do plano, defaults).
2. Suba o ambiente e confirme que está verde antes de mexer em qualquer coisa:
   `docker compose up -d && cp .env.example .env && ./db/dev-reset.sh && ./db/tests/run.sh` (deve terminar com "TODOS OS TESTES PASSARAM").
3. **Não altere migrations já existentes (001–012).** Se precisar mudar o banco, crie `013_*.sql` em diante, rode `./db/migrate.sh` e adicione testes em `db/tests/test_db.sql`. Antes de criar uma migration, diga por que a API não resolve sem ela.
4. Trabalhe por fases (seção 6). Ao fim de cada fase: rode os testes, faça um commit com mensagem clara e me mostre um resumo curto do que ficou pronto e do que ficou de fora. Não avance se a fase atual não passar nos critérios de aceite.

## 1. Contrato de segurança com o banco (o ponto mais crítico)

- A API conecta como **`sd_app`** (`DATABASE_URL`), que é sujeita a RLS, **não** tem BYPASSRLS e **não lê `users.password_hash`**.
- **Em TODA transação** de requisição autenticada: `BEGIN; SELECT app_set_context($tenantId, $userId); ...queries...; COMMIT;` (o contexto é `LOCAL`, vale só naquela transação). Sem contexto o banco devolve zero linhas (falha fechada). Nunca use uma conexão do pool fora de uma transação com contexto para dados de tenant.
- Implemente um `DbService` com `withTenant(tenantId, userId, async (client) => ...)` que abre a transação, seta o contexto, executa, faz COMMIT/ROLLBACK e **sempre** libera a conexão. Todo acesso a dados de tenant passa por ele. Um interceptor/decorator `@Tx()` que injeta o `client` da requisição é bem-vindo, desde que a transação seja garantidamente encerrada.
- **Não confie no papel (`role`) vindo do JWT.** O banco decide: a RLS usa `app_role()`, calculado a partir de `memberships`. Use o papel do JWT apenas para esconder/mostrar coisas na UI; para autorização real, deixe a RLS barrar e traduza o erro. Reconsulte o membership a cada requisição (ou cacheie por poucos segundos) para que um usuário desativado perca acesso rápido.
- Em todo `INSERT` informe `tenant_id` explicitamente (as policies fazem `WITH CHECK tenant_id = app_tenant_id()`).
- **Não escreva `WHERE tenant_id = ...` como mecanismo de segurança.** A RLS é a proteção; filtro manual só se for útil para índice.
- Segundo cliente de banco para o **worker**: `sd_worker` (`DATABASE_URL_WORKER`), BYPASSRLS, com grants mínimos. Use-o **apenas** em jobs (outbox de e-mail, `sla_mark_breaches()`, webhooks de cobrança). Nunca em handlers HTTP de usuário.
- Mapeie erros do Postgres para HTTP de forma centralizada (um `ExceptionFilter`):

| SQLSTATE / mensagem | HTTP | `code` na resposta |
|---|---|---|
| `42501` (RLS / sem permissão) | 403 | `forbidden` |
| `23503` (FK, ex.: referência de outro tenant) | 422 | `invalid_reference` |
| `23505` (unique) | 409 | `conflict` |
| `23514` + `ticket_quota_exceeded` | 402 | `ticket_quota_exceeded` |
| `23514` + `agent_limit_reached` | 402 | `agent_limit_reached` |
| `23514` + `tenant_inactive` | 402 | `tenant_inactive` |
| `23514` + `assignee_must_be_staff` | 422 | `assignee_must_be_staff` |
| `email_already_registered` | 409 | `email_already_registered` |
| `invitation_invalid_or_expired` | 410 | `invitation_invalid` |

Nunca devolva `SQLERRM`/stack ao cliente; logue no servidor e devolva `{ code, message }` em pt-BR amigável.

## 2. O que o banco já oferece (use, não recrie)

**Funções (todas com `search_path` fixo):**
- Cadastro: `signup_tenant(name, slug, email, admin_name, password_hash)` → `(out_tenant_id, out_user_id)`; `create_tenant_for_user(user, name, slug)`.
- Login: `auth_get_user_by_email(email)` → `(id, email, name, password_hash, disabled)`; `auth_list_memberships(user)`; `auth_touch_login(user)`; `auth_set_password(user, hash)`; `tenant_by_slug(slug)`.
- Convites: insira em `invitations` (como admin) guardando **apenas o hash SHA-256 do token** em `token_hash`; `accept_invitation(token_hash, name, password_hash)` → `(out_tenant_id, out_user_id)`.
- Sessões: `auth_issue_refresh(user, tenant, token_hash, ttl)` → family_id; `auth_rotate_refresh(old_hash, new_hash, ttl)` → `(status, user_id, tenant_id, family_id)` com `status ∈ ok|reused|invalid` (em `reused` o banco já revogou a sessão inteira: responda 401 e limpe o cookie); `auth_revoke_refresh(hash)` (logout); `auth_revoke_all_refresh(user)`.
- Recuperação de senha: `auth_request_password_reset(email, token_hash)` → 0 ou 1 linha `(out_user_id, out_email, out_name)` (a API envia o e-mail e responde **sempre igual**); `auth_reset_password(token_hash, new_password_hash)` → boolean (uso único, 1 h, revoga sessões).
- Relatórios: `report_overview(from, to)` → `jsonb` pronto para o dashboard (só equipe; respeita a RLS). Não recalcule isso na API.
- Tabelas `macros` (respostas prontas) e `saved_views` (filtros salvos): CRUD direto via `sd_app`; a RLS cuida de dono/compartilhado.
- Worker: `sla_mark_breaches()` (a cada minuto), `auth_purge_expired()` (1x/dia), `delete_tenant(uuid)`.
- SLA: view `v_ticket_sla (ticket_id, kind, due_at, state, minutes_remaining)` com `state ∈ running|paused|met|met_late|breached`.

**Triggers que já fazem o trabalho** (não duplique): número sequencial do chamado por tenant; status/prioridade/organização/fila padrão; cliente (`requester`) não consegue definir status, prioridade, fila nem responsável; criação e recálculo dos cronômetros de SLA (em minutos úteis, pausa em status com `sla_pauses`); primeira resposta; resposta do cliente reabre "Aguardando cliente"/"Resolvido"; auditoria em `ticket_events`; e-mails enfileirados em `email_outbox`; limites de agentes e de chamados por plano; tenant suspenso não abre chamado.

**O que `sd_app` pode fazer** (veja `008_rls_and_grants.sql`; erros de permissão virão como `42501`):
- `tickets`: `INSERT`, e `UPDATE` **somente** nas colunas `subject, description, assignee_id, queue_id, category_id, priority_id, status_id, organization_id, tags, custom_fields`. **Não existe DELETE** de chamados. `first_response_at`, `resolved_at`, `number`, `sla_policy_id` são do banco.
- `ticket_messages`: `INSERT` com `author_id = usuário atual`. Cliente só pode `public_reply` em chamado que enxerga; nota interna é só da equipe e **cliente nunca a vê**.
- `ticket_events`, `sla_timers`: somente leitura e só para a equipe. `email_outbox`, `billing_events`, `tenant_counters`: sem acesso.
- Cliente (`requester`) só enxerga os próprios chamados.

**Papéis:** `admin`, `agent`, `requester`. Seed de dev: workspace `demo`, senha `demo1234` para todos — `admin@demo.local`, `carlos@demo.local`, `bia@demo.local` (agentes), `joao@acme.local`, `maria@acme.local`, `pedro@globex.local` (clientes). O hash do seed é bcrypt `$2a$` (gerado pelo pgcrypto), compatível com `bcryptjs`.

## 3. API NestJS — requisitos

**Stack:** NestJS (última estável) + TypeScript estrito, `pg` direto (**sem ORM** — o controle da transação/contexto é essencial; use queries parametrizadas), `class-validator`/`class-transformer` com `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`, `@nestjs/jwt`, `@nestjs/config` com validação do `.env`, `@nestjs/schedule`, `@nestjs/throttler`, `helmet`, `bcryptjs` (ou `argon2`), Swagger (`/docs`) em dev. Prefixo `/api/v1`. Estrutura em módulos: `auth`, `tenants`, `users`, `tickets`, `catalog`, `kb`, `reports`, `billing`, `worker`, `common` (db, filtros, guards, decorators).

**Auth (duas etapas, pois um usuário pode pertencer a vários workspaces):**
1. `POST /auth/login {email, password}` → valida com `auth_get_user_by_email` (bcrypt; rejeite `disabled`; tempo de resposta uniforme mesmo se o e-mail não existir) → devolve token curto **sem tenant** + lista de workspaces (`auth_list_memberships`). Se houver um único workspace, já devolva o token com tenant.
2. `POST /auth/select-tenant {tenantId}` → confirma o membership e devolve o JWT final `{sub: userId, tid: tenantId}`.
- Access token curto (15 min) + refresh token em cookie `httpOnly; Secure; SameSite=Lax` com rotação via `auth_rotate_refresh`. `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/logout-all`, `GET /auth/me` (usuário, tenant, papel, plano, status do trial).
- `POST /auth/signup {workspaceName, slug, name, email, password}` usa `signup_tenant`. Valide slug (`^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`, não reservado: `www api admin app`), senha mínima 8, e e-mail normalizado em minúsculas.
- `POST /auth/accept-invite {token, name, password}`; `POST /auth/forgot-password` e `POST /auth/reset-password` (use as funções `auth_request_password_reset` / `auth_reset_password`; resposta idêntica exista o e-mail ou não; gere o token com `crypto.randomBytes` e guarde só o SHA-256).
- Rate limit forte em login/signup/forgot (por IP e por e-mail).
- Guards: `JwtAuthGuard` global (com `@Public()` para exceções) e `@Roles('admin','agent')` apenas como **primeira barreira**; a decisão final é da RLS.

**Endpoints (todos sob `withTenant`; listas paginadas por cursor `?limit=&cursor=`, máx. 100):**
- **Chamados** — `GET /tickets` com filtros: `status` (id ou `kind`), `assignee` (`me|none|<id>`), `queue`, `category`, `priority`, `organization`, `sla` (`breached|running|paused`), `tag`, `q` (busca full-text: `search @@ websearch_to_tsquery('portuguese', $q)`, com fallback `subject ILIKE` / trigram), `createdFrom/createdTo`, `sort` (`updated|created|priority|due`). Retorne já com nome de status/prioridade/responsável/solicitante e o estado do SLA (join na `v_ticket_sla`) para evitar N+1.
- `POST /tickets`, `GET /tickets/:id` (inclui mensagens visíveis ao papel, anexos, eventos só para equipe, timers de SLA, horas apontadas), `PATCH /tickets/:id` (apenas colunas permitidas; aceite alteração em lote de vários campos numa transação), `POST /tickets/:id/messages {kind, body}`, `POST /tickets/bulk` (atribuir/mudar status de vários).
- `POST /tickets/:id/time-entries`, `GET /tickets/:id/time-entries`, `DELETE /time-entries/:id`.
- **Anexos:** URL pré-assinada (S3 compatível; MinIO no `docker-compose` para dev). `POST /tickets/:id/attachments/presign {filename, contentType, size}` valida tipo/tamanho (≤ 25 MB, lista de MIME permitidos) e gera `storage_key` com prefixo do tenant; `POST .../attachments/confirm` grava em `attachments`; `GET /attachments/:id/download` devolve URL de download de curta duração **depois de** conferir via RLS que o usuário enxerga o anexo.
- **Catálogo (admin):** CRUD de `queues`, `categories`, `priorities`, `statuses`, `business_hours` (+ faixas e feriados), `sla_policies`, `automation_rules`; leitura de status/prioridades/categorias liberada a todos.
- **Equipe e clientes:** `GET/PATCH /members` (papel, ativo), `POST /invitations`, `GET /organizations` + CRUD, `GET /agents`.
- **Base de conhecimento:** CRUD de `kb_articles` (equipe), `GET /kb` (busca full-text; cliente só vê `published` + `portal`), `GET /kb/:slug`. Slug único por tenant (gere a partir do título).
- **Relatórios:** `GET /reports/overview?from=&to=` apenas repassa `report_overview(from, to)` (já traz abertos por status, vencidos, tempos médios, % SLA cumprido, série diária, por agente/categoria/prioridade e horas apontadas). Valide o período (máx. 366 dias) e converta erro `22023` em 400.
- **Macros e visões salvas:** CRUD de `/macros` e `/saved-views` (equipe). No editor de resposta, aplique a macro substituindo variáveis como `{{solicitante.nome}}` no servidor.
- **Conta/plano:** `GET /tenant` (plano, uso de agentes e de chamados no mês, trial), `PATCH /tenant`.
- **Cobrança (fase final):** `POST /billing/checkout` e `POST /billing/webhook/:provider` (Asaas e/ou Stripe; abstraia atrás de uma interface). O webhook usa `sd_worker`, **valida a assinatura/token do provedor**, é **idempotente** via `billing_events (provider, event_id)` e atualiza `subscriptions`/`tenants.status/plan_id`. Sem credenciais, deixe um provedor `fake` para dev.
- `GET /health` (checa o banco) e `GET /health/ready`.

**Worker (processo/módulo separado, `sd_worker`):**
- A cada minuto: `SELECT sla_mark_breaches()` e log do total.
- Consumidor da `email_outbox`: reserve linhas com `SELECT ... WHERE status IN ('pending','failed') AND scheduled_at <= now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT n`, marque `sending`, renderize o template (`ticket_created`, `ticket_reply`, ...), envie via SMTP (nodemailer; Mailpit no `docker-compose` para dev), marque `sent` ou `failed` com `attempts + 1`, `last_error` e backoff exponencial; desista após N tentativas. Seguro para rodar em várias instâncias.
- **Avaliador de automações:** consuma eventos novos de `ticket_events`/chamados criados e aplique `automation_rules` (condições/ações em JSON; ações: `assign_queue`, `assign_agent`, `set_priority`, `add_tag`, `notify_staff`). Comece com poucos operadores (`eq`, `in`, `contains`) e documente o formato. Evite loops (uma regra não dispara a si mesma em cascata).
- Limpeza diária: `SELECT auth_purge_expired()`.
- Alertas de SLA próximo do vencimento (ex.: 80% do prazo) via e-mail para o responsável.

**Qualidade da API:** logs estruturados (pino) com `requestId`, sem dados sensíveis; CORS restrito à origem do front; `helmet`; tamanho máximo de body; nunca logar senhas, tokens ou `password_hash`.

## 4. Front React — requisitos

**Stack:** Vite + React 18 + TypeScript estrito, React Router, TanStack Query, React Hook Form + Zod, Tailwind + componentes tipo shadcn/ui (ou Radix), `date-fns` (pt-BR), ícones `lucide-react`. Cliente HTTP único com refresh automático do token e tratamento padronizado dos `code` de erro da API. Proxy do Vite para `/api` em dev. Interface 100% em **pt-BR**, responsiva (usável no celular), acessível (foco visível, labels, navegação por teclado), com tema claro/escuro.

**Duas experiências no mesmo app, decididas pelo papel retornado em `/auth/me`:**

*Painel da equipe (`admin`/`agent`):*
- **Chamados**: tabela com filtros salvos (de `/saved-views`; "Meus abertos", "Sem responsável", "SLA vencido", "Aguardando cliente"), busca, ordenação, paginação, seleção múltipla com ações em lote, atalhos de teclado, atualização periódica (polling leve ou SSE). Badges de prioridade e de SLA (tempo restante em verde/amarelo/vermelho, "pausado", "estourado").
- **Detalhe do chamado**: linha do tempo unificada (mensagens públicas, notas internas destacadas, eventos de auditoria), editor de resposta com alternância clara **"Resposta pública" × "Nota interna"** (padrão seguro: pública só após confirmação visual do destinatário), troca de status/prioridade/responsável/fila/categoria/tags inline, cronômetros de SLA, apontamento de horas, anexos (arrastar e soltar com progresso), respostas prontas (macros, de `/macros`) e artigos da KB sugeridos/inseríveis.
- **Novo chamado** (em nome de um cliente), **Dashboard** (cards + gráficos de `/reports/overview`), **Base de conhecimento** (editor Markdown com preview), **Clientes/Organizações**, **Configurações** (equipe e convites, filas, categorias, prioridades, status, horário comercial e feriados, políticas de SLA, automações, plano e uso).

*Portal do cliente (`requester`):* **Meus chamados** (lista simples), **Abrir chamado** (assunto, descrição, categoria, anexos; sem campos de prioridade/responsável), **detalhe** com a conversa pública e resposta, e **busca na KB** (sugerir artigos enquanto digita o assunto, antes de enviar). O cliente nunca vê nota interna, auditoria nem cronômetros.

*Públicas:* login (com seletor de workspace quando houver mais de um), cadastro self-service (cria o workspace e inicia o trial de 14 dias), esqueci a senha, aceitar convite.

**Estados e qualidade:** loading com skeletons, estados vazios úteis, erros acionáveis, confirmação em ações destrutivas, UI otimista em mudanças de status com rollback, tratamento de `402` (cota/plano) com CTA de upgrade e de `tenant_inactive` com tela de conta suspensa. Guarda de rotas por papel. Nenhum segredo no bundle. Tokens: access em memória, refresh em cookie `httpOnly`.

## 5. Estrutura de repositório sugerida

```
helpdesk-saas/
  db/            (já existe — não quebrar)
  api/           NestJS (src/, test/, Dockerfile)
  web/           Vite React (src/, Dockerfile ou build estático)
  docker-compose.yml   (adicionar: api, worker, web, minio, mailpit; manter o db)
  .env.example         (atualizar com JWT_SECRET, SMTP_*, S3_*, CORS_ORIGIN...)
  README.md            (atualizar: como subir tudo, arquitetura, decisões)
```
Considere workspaces npm/pnpm na raiz para compartilhar tipos (um pacote `shared/` com os tipos de DTO e enums de status, papel, SLA).

## 6. Fases e critérios de aceite

Faça nesta ordem, uma fase por vez, com commit ao final de cada uma.

1. **Esqueleto da API + DB + Auth.** `DbService.withTenant`, config validada, filtro de erros, `/health`, signup/login/select-tenant/refresh/me, guards. *Aceite:* testes e2e provando login com os usuários do seed; sem token → 401; **uma requisição sem contexto de tenant enxerga 0 linhas**; usuário do tenant A não lê dados do tenant B nem forjando IDs na URL.
2. **Chamados.** Listagem com todos os filtros, criação, detalhe, patch, mensagens, horas, em lote. *Aceite (e2e, contra o Postgres real, nada de mock de banco):* cliente vê só os seus chamados e nunca notas internas; cliente não consegue definir prioridade/responsável; agente vê todos; mudança de status para "Aguardando cliente" pausa o SLA (`GET /tickets/:id` mostra `paused`); resposta do cliente reabre; cota do plano devolve 402 com o `code` correto; busca full-text em português acha "impressora" para "impressoras".
3. **Catálogo, equipe, convites, KB, relatórios, tenant.** *Aceite:* só admin altera catálogo/SLA; convite com token expira/é de uso único; limite de agentes do plano devolve 402; relatórios batem com contagens feitas direto no SQL do seed.
4. **Worker.** SLA, outbox de e-mail (Mailpit), automações, alertas. *Aceite:* abrir chamado no e-mail de dev gera mensagem no Mailpit; dois workers simultâneos não enviam o mesmo e-mail duas vezes; chamado vencido é marcado em até 1 minuto.
5. **Front — base e portal do cliente.** Auth, layout, portal completo. *Aceite:* fluxo completo no navegador de cliente: cadastro/convite → login → abrir chamado → ver resposta → responder.
6. **Front — painel da equipe.** Lista, detalhe, dashboard, KB, configurações. *Aceite:* fluxo completo de atendente; teste E2E com Playwright cobrindo: login, filtrar "SLA vencido", abrir chamado, nota interna (e verificar que o cliente não a vê), resolver, reabrir.
7. **Anexos + cobrança + acabamento.** S3/MinIO, checkout/webhook (provedor fake + um real se houver credenciais), landing de preços, Dockerfiles, CI (GitHub Actions: `./db/tests/run.sh`, lint, testes da API, build do web, Playwright), README final.

## 7. Regras de trabalho (importante)

- **Teste de verdade.** Suba o Postgres, rode a API e exercite os endpoints (e2e/supertest e, no front, Playwright). Se algo não puder ser testado, diga explicitamente — nunca declare "funcionando" sem executar.
- Não invente colunas, funções ou tabelas: confira nas migrations. Se faltar algo, proponha uma migration `013+` com teste, em vez de contornar na API.
- Segurança primeiro: qualquer atalho que pule `withTenant`, use `sd_worker` em rota de usuário, ou concatene SQL com entrada do usuário é **bug bloqueante**. Sempre queries parametrizadas.
- Não adicione dependências sem necessidade; fixe versões; rode `npm audit` e relate o que for crítico.
- Código pequeno, tipado e legível; um módulo por domínio; nada de `any` sem justificativa; comentários só onde o porquê não é óbvio.
- Se uma decisão for ambígua e **cara de desfazer** (modelo de dados, provedor de cobrança, estratégia de sessão), pare e me pergunte com 2–3 opções e sua recomendação. Para o resto, decida, registre no README em "Decisões" e siga.
- No fim de cada fase, liste: o que foi feito, como testar manualmente (comandos exatos), limitações conhecidas e a próxima fase.

Comece pela **seção 0** (ler o banco e conferir que os testes passam) e depois pela **fase 1**. Antes de codar a fase 1, me mostre em poucas linhas o plano de pastas/módulos que vai criar.
