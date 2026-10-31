# Helpdesk SaaS

Service desk multi-tenant no estilo Desk Manager/Freshdesk. Inclui:

- **Chamados** com SLA em horário comercial, filas, categorias e prioridades.
- **Portal do cliente** e **painel da equipe**.
- **Base de conhecimento**, **automações**, **apontamento de horas** e **relatórios**.
- **Anexos** em S3 e **planos com cobrança** (Asaas).

| Camada | Tecnologia |
|---|---|
| Banco | PostgreSQL 16 — RLS por tenant, regras de negócio e SLA em SQL (`db/`) |
| API | NestJS 12 (ESM) + `pg` puro, sem ORM (`api/`) |
| Worker | processo separado da mesma imagem (`api/src/worker`) |
| Front | Vite + React 18 + TS, React Router 7, TanStack Query, Tailwind 4 (`web/`) |
| Tipos compartilhados | `shared/` (`@helpdesk/shared`) |

## Rodar em desenvolvimento

Pré-requisitos: Docker, Node 22+, **npm 11** (`npm i -g npm@11`; o npm 10 tem um bug com estes workspaces) e o cliente `psql`, usado pelos scripts de `db/`.

```bash
docker compose up -d                 # Postgres 16, Mailpit (e-mail) e S3 de dev (SeaweedFS)
cp .env.example .env
./db/dev-reset.sh                    # recria o banco: roles + migrations 001–013 + seed
npm ci && npm run build              # shared, api e web
```

Em três terminais:

```bash
npm run start:prod -w api            # API em http://localhost:3000 (Swagger em /docs)
npm run start:worker -w api          # worker: SLA, e-mails, automações
npm run dev -w web                   # app em http://localhost:5173
```

| Endereço | O quê |
|---|---|
| http://localhost:5173 | app (`/precos` é a vitrine; `/entrar` o login) |
| http://localhost:3000/docs | Swagger da API |
| http://localhost:8025 | Mailpit: todos os e-mails enviados em dev (convites, respostas, reset de senha) |

Logins do seed (senha `demo1234`):
- admin: `admin@demo.local`;
- agentes: `carlos@demo.local`, `bia@demo.local`;
- clientes: `joao@acme.local`, `maria@acme.local`, `pedro@globex.local`.

### Tudo em contêineres

```bash
docker compose up -d && ./db/dev-reset.sh            # infra + banco
docker compose --profile full up -d --build          # api, worker e web (Nginx) → http://localhost:8080
```

Atrás de proxy corporativo com TLS interceptado, construa as imagens passando a CA como *secret* (ela não fica na imagem):
`docker build --secret id=npm_ca,src=ca.crt -f api/Dockerfile .`

## Testes

```bash
npm run test:db        # suíte SQL (roda como sd_app/sd_worker de verdade)
npm run test:api       # unitários + e2e da API e do worker contra Postgres, Mailpit e S3 reais
npm run test:web       # Playwright no navegador (sobe API e Vite sozinho)
npm run lint           # oxlint + tsc (api e web)
```

O CI (`.github/workflows/ci.yml`) roda tudo isso a cada PR: banco, build, lint, `npm audit`, testes da API, Playwright e build das imagens Docker.

## Estrutura

```
db/                   migrations 001–013, seed, testes SQL, scripts (bootstrap/migrate/dev-reset)
shared/               tipos, enums e constantes compartilhados API ⇄ front
api/
  src/common/           DbService.withTenant (contexto de tenant), erros → { code, message }, guards, rate limit
  src/auth/             login em 2 etapas, refresh com rotação, signup, convite, reset de senha
  src/tickets/          chamados, mensagens, lote, horas, anexos (S3)
  src/catalog/          filas, categorias, prioridades, status, horário comercial, SLA, automações, respostas prontas
  src/team/  src/kb/  src/reports/  src/tenants/  src/billing/  src/storage/  src/health/
  src/worker/           processo separado (sd_worker): SLA, outbox de e-mail, automações, alertas
  test/                 e2e (vitest + supertest)
web/
  src/lib/api.ts        cliente HTTP único: token em memória, refresh "single flight"
  src/pages/public/     login, cadastro, senha, convite, conta suspensa
  src/pages/portal/     portal do cliente
  src/pages/staff/      painel da equipe e configurações
  src/pages/billing/    preços e checkout simulado
  e2e/                  Playwright
docker/  docker-compose.yml  api/Dockerfile  web/Dockerfile (+ nginx.conf)
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

## Decisões do banco

- Ao retomar um SLA pausado, o prazo é empurrado pelo tempo corrido de pausa (não em minutos úteis).
- `password_hash`: gere com bcrypt/argon2 na API. O seed usa bcrypt (`$2a$`).
- Busca textual (`portuguese`) e trigram em `tickets.subject`; sem `unaccent` aplicado ainda.
- Não há tabela de campos customizados (usa-se `tickets.custom_fields jsonb`), nem caixas de e-mail de entrada, nem CMDB/field service — ficam para depois do MVP.

## Decisões da API e do front

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
  e o reset derruba todas as sessões. O e-mail sai pela `email_outbox` (agora com `tenant_id` opcional); o worker
  apaga o token do payload depois de enviar.
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
- **Formato das automações** (validado na API e avaliado pelo worker). Todas as condições precisam valer (E).
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
- **Front**:
  - O access token fica só em memória; o refresh fica em cookie httpOnly, e o teste confere que nada vaza para `localStorage` ou `document.cookie`.
  - 401 dispara um único refresh compartilhado ("single flight"). Abas diferentes ainda podem disputar o refresh, o que derruba a sessão.
  - O papel da sessão só escolhe a área (portal ou painel); quem autoriza é a API/RLS.
  - `/chamados/:id` (link de e-mail da equipe) aberto por cliente redireciona para o portal.
  - O tema claro/escuro/sistema é aplicado antes do primeiro paint.
  - Telas autenticadas são carregadas sob demanda.
  - Na KB, a busca casa **qualquer** termo relevante, ordenando por relevância, porque o cliente digita frases inteiras. A busca de chamados continua exigindo todos os termos.
  - API e front usam **um único Vite (8.x)**. Com o Vite 6 hoisted, o Vitest compilava sem `emitDecoratorMetadata` e a injeção do Nest quebrava.
- **Painel da equipe**:
  - **Lista de chamados**:
    - Filtros vão para a URL (link compartilhável). Visões salvas: Meus abertos, Sem responsável, SLA vencido, Aguardando cliente, Todos abertos.
    - Ações em lote num único `POST /tickets/bulk`.
    - Atalhos: `j`/`k`, `Enter`/`o`, `x`, `/`, `n`, `?`.
    - Atualização a cada 30 s.
  - **Selo de SLA**: mostra o cronômetro mais urgente (estourado > o que vence primeiro > pausado). Verde > 2 h, amarelo ≤ 2 h, vermelho estourado, sempre com ícone e texto.
  - **Editor de mensagem**:
    - Começa em **Nota interna** e volta para ela após cada envio.
    - "Resposta pública" mostra o nome e o e-mail do destinatário, e o botão vira "Enviar ao cliente".
  - **Alterações no chamado**: status com UI otimista e rollback se a API recusar (coberto por teste com falha simulada).
  - **Configurações**: só admin. A tela esconde a seção e a API/RLS bloqueia de fato.
  - **Gráficos**: SVG próprio, sem biblioteca. Cores das séries validadas para daltonismo e contraste nos dois temas (`--color-series-*`), com legenda, tooltip e "Ver como tabela".
  - **Respostas prontas**: tabela `macros` (migration 013), em que a equipe lê e o admin edita. No navegador elas não seriam compartilhadas, e em `kb_articles` misturariam texto interno com conteúdo do cliente.
- Erros de validação: `{ code: 'validation_failed', details: [{ field, message }] }` em pt-BR.
- Stack: NestJS 12 (ESM), vitest (template oficial do Nest 12), pg sem ORM, zod para validar o env, pino com `requestId`
  e redação de `authorization`/`cookie`/senhas/tokens.
- **Anexos**:
  - Upload direto do navegador para o S3 por URL pré-assinada. O tipo e o tamanho entram na assinatura, então o S3 recusa outro arquivo.
  - A chave começa com `tenant/chamado/`, e o *confirm* só aceita chaves desse prefixo e confere o objeto (HEAD).
  - O download sai por URL de 5 minutos, emitida só depois de a RLS confirmar que o usuário enxerga o anexo. O anexo de nota interna é invisível para o cliente.
  - Tipos permitidos: lista fechada, sem HTML/SVG/executáveis; até 25 MB.
  - Em dev, o S3 é o **SeaweedFS**, porque o MinIO deixou de publicar imagens Docker. O código fala S3 puro: em produção vale AWS S3, R2, MinIO etc.
- **Cobrança**:
  - Interface `BillingProvider` com o **provedor de teste** (dev/CI: checkout simulado e webhook assinado com HMAC) e o **Asaas**: assinatura mensal com `billingType: UNDEFINED` (Pix, boleto ou cartão); o webhook é autenticado pelo token do painel (`asaas-access-token`).
  - O checkout não grava nada. Tenant e plano vão no `externalReference`, e **só o webhook verificado** muda `tenants.plan_id/status` e `subscriptions`.
  - O webhook usa `sd_worker`, num pool exclusivo do módulo de cobrança. É idempotente por `billing_events (provider, event_id)`: retentativas do provedor não reprocessam.
  - Pagamento aprovado → plano ativo; atraso → `past_due`; cancelamento → `canceled`, e a conta para de aceitar chamados com 402.
  - **O Asaas não foi testado contra o serviço real** (sem credenciais aqui). O formato das chamadas tem testes unitários com `fetch` simulado, e o webhook tem e2e. Para ativar: `BILLING_PROVIDER=asaas`, `ASAAS_API_KEY` e `ASAAS_WEBHOOK_TOKEN` (sandbox: `https://api-sandbox.asaas.com/v3`), e cadastrar no Asaas o webhook `POST /api/v1/billing/webhook/asaas`.

## Limitações conhecidas

- Rate limit em memória (por instância); com várias instâncias, usar Redis.
- Duas abas renovando a sessão ao mesmo tempo disparam a detecção de reuso do refresh e derrubam a sessão.
- Alterar uma política de SLA não recalcula chamados já abertos. O alerta de 80% usa tempo corrido, não minutos úteis.
- O worker de automações olha eventos do último dia (um worker parado por mais de 24 h perde os anteriores).
- Edição simultânea do mesmo chamado: vale a última alteração (sem controle otimista de versão).
- Trocar para um plano menor não remove agentes acima do limite (o limite vale para novas inclusões).
- Cada checkout no Asaas cria um cliente novo no provedor; não há reaproveitamento.
- `npm audit`: 2 alertas **moderados** em `minimatch`, puxado pelo `@nestjs/cli` (ferramenta só de build, não vai para a imagem de produção nem recebe entrada de usuário). A correção oficial exige downgrade do CLI; o CI barra a partir de severidade alta.
