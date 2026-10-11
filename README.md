# Conty — Origem do cadastro no app

API local do [desafio 06](https://challenge.appconty.com/desafios/origem-cadastros). Um token opaco identifica campanha ou indicação, o resolvedor emite um clique idempotente, a primeira abertura ancora a janela e o cadastro persiste uma decisão auditável. Nenhum fluxo depende de `Referer`.

## Rodar

Use **Node 22.23.3** (`.nvmrc`) e npm. Não precisa instalar SQLite nem um serviço externo: o banco é o `node:sqlite` nativo, ainda experimental no Node 22. TypeScript estrito, Hono e Vitest completam a stack.

```sh
npm ci
npm run typecheck
npm test
npm run demo
npm run build
npm start
```

No PowerShell, use `npm.cmd` se a política local bloquear `npm.ps1`. A API escuta em `http://127.0.0.1:3000`; `GET /health` retorna `{"status":"ok"}`. `PORT` troca a porta, `DB_PATH` troca o arquivo (padrão `data/attribution.sqlite`). O diretório é criado automaticamente. Feche com Ctrl+C; reiniciar mantém os dados.

`npm run demo` abre uma porta local aleatória, usa **HTTP real** e um banco temporário dentro de `data/`. O mock app guarda o payload do link resolvido e o reutiliza no retry. O comando verifica resolução repetida, campanha → indicação → cadastro, auditoria do retry, toque retroativo recebido depois do cadastro, retry do cadastro e leitura idêntica após fechar/reabrir o banco e o servidor. Imprime as respostas e apaga somente seu banco temporário. Não precisa de servidor já iniciado.

## Regras oficiais e escolhas desta entrega

O enunciado pede contrato de link/primeira abertura/cadastro, suporte sem referrer, clique repetido, dois links e empate, janela ancorada na primeira abertura, exclusão de toque posterior ao cadastro, orgânico com motivo e resposta auditável. Não fornece base nem define duração, prioridade ou desempate.

As escolhas **propostas** desta implementação são:

- Janela de **7 × 24 horas**, intervalo fechado `[first_open_at, first_open_at + 7 dias]`, em UTC.
- Vence o **último toque elegível**. Em horário igual, vence o menor `click_id` pela ordem ASCII, sem prioridade entre campanha e indicação.
- Toque exatamente em `signed_up_at` é elegível; 1 ms depois fica `after_signup`.
- Um cadastro pode acontecer depois dos 7 dias; somente os toques dentro da janela são candidatos.
- `first_open_at` é o horário da primeira abertura **persistida**, não o menor horário recebido posteriormente. Nunca é substituído.
- Um signup por instalação. Retry com o mesmo `signup_id` devolve a decisão original, mesmo se outro horário válido for enviado. Outro `signup_id` na mesma instalação ou o mesmo ID noutra instalação gera 409.

## O que viaja no link

| Origem | Link compartilhável demonstrativo | Identidade mantida no servidor |
|---|---|---|
| Campanha | `https://go.example.test/o/tok_cmp_summer` | campaign / summer_2026 |
| Indicação | `https://go.example.test/o/tok_ref_crt123` | referral / crt_123 |

Os domínios `.test` são exemplos, sem redirect ou SDK móvel real. Na demonstração, o caller extrai o token da URL e chama `POST /origins/:originToken/resolve`. Uma chave por clique lógico (`browser-session-a:tap-001`) emite um `click_id`; repetir `(token, idempotency_key)` retorna o mesmo clique e seus metadados originais. Outra chave no mesmo token representa um clique legítimo diferente.

O resolvedor devolve `https://app.example.test/open?origin_token=tok_cmp_summer&click_id=clk_<uuid>`. O app guarda **token + click_id** e preserva o par em retries. A autoria nunca vem de um `origin_id` editável no link: o servidor consulta o token e verifica se o clique foi emitido para ele. Token desconhecido/inativo no resolvedor gera 404/410.

## O que o app grava e o cadastro consome

Na primeira chamada de `opens`, a API grava instalação, `first_open_at`, toque originador e recibo na **mesma transação SQLite**. Falha em qualquer inserção reverte tudo. A primeira abertura pode ser orgânica, sem token nem clique. Para uma abertura com origem, `touched_at = opened_at`; o horário `original_click_at` do resolvedor é apenas auditoria e não pode antecipar a janela.

Aberturas seguintes e `touches` podem trazer novos cliques, preservando a âncora. A chave `(installation_id, click_id)` deduplica o toque; cada recebimento ganha um recibo separado. Um replay com token ou horário alterado não modifica o primeiro toque, e o payload recebido continua no recibo. Dois cliques do mesmo token continuam distintos. Um par inválido também ocupa essa identidade; corrigir seu payload por replay não o transforma em toque válido.

No cadastro, a política em `src/policy.ts` avalia somente toques da instalação e persiste `decision_json`, origem e motivo na mesma transação. A decisão fica congelada. `GET /signups/:signupId/attribution` separa `decision` (snapshot original) de `subsequent_receipts` (fatos posteriores).

Um link **recebido depois do commit do cadastro** é marcado `recorded_after_signup` na transação de recebimento. Mesmo com `touched_at` retroativo ou relógio de recebimento igual/anterior, fica `after_signup`, não participa da decisão e nunca muda a origem. A ordem persistida e o corte de recibos protegem essa regra; não se compara apenas o horário informado pelo cliente. Um toque recebido antes do cadastro cujo `touched_at > signed_up_at` também é excluído.

## API e exemplos HTTP

JSON obrigatório em POST. IDs aceitam letras ASCII, números, `_` e `-`, até 128 caracteres. A chave idempotente aceita até 200 caracteres, sem espaços nas extremidades. Datas exigem UTC **canônico com milissegundos**, `YYYY-MM-DDTHH:mm:ss.SSSZ`; datas impossíveis, offsets e campos extras geram 400 sem escrita. Token e clique são fornecidos juntos. Esta é uma API pública local demonstrativa, sem autenticação.

| Método / rota | Corpo | Resposta |
|---|---|---|
| `POST /origins/:token/resolve` | `idempotency_key`, `original_click_at` opcional | 201 novo / 200 retry; clique, token, horário original, deep link, duplicate |
| `POST /installations/:id/opens` | `opened_at`, token+clique opcionais | 201 primeira / 200 posterior; âncora, first_open, duplicate, toque e recibo |
| `POST /installations/:id/touches` | `origin_token`, `click_id`, `touched_at` | 201 novo / 200 replay; duplicate, toque e recibo |
| `POST /installations/:id/signup` | `signup_id`, `signed_up_at` | 200; decisão imutável |
| `GET /signups/:id/attribution` | — | 200; decision + subsequent_receipts |

`touches` e `signup` requerem instalação existente (404); signup anterior ao first open ou IDs de cadastro conflitantes geram 409. Token/clique inválido em `opens` ou `touches` é aceito para auditoria, mas nunca vence. Erros seguem `{"error":{"code":"...","message":"..."}}`.

Com `npm start` aberto, execute no PowerShell (use `inst_exemplo_2`/`signup_exemplo_2` se quiser um fluxo novo):

```powershell
$base = 'http://127.0.0.1:3000'
function Post-Json($route, $payload) {
  Invoke-RestMethod -Method Post -Uri "$base$route" -ContentType 'application/json' -Body ($payload | ConvertTo-Json)
}
$campaign = Post-Json '/origins/tok_cmp_summer/resolve' @{
  idempotency_key = 'example:campaign:1'
  original_click_at = '2026-10-01T11:59:58.000Z'
}
$savedOpen = @{
  opened_at = '2026-10-01T12:00:00.000Z'
  origin_token = 'tok_cmp_summer'
  click_id = $campaign.click_id
}
Post-Json '/installations/inst_exemplo/opens' $savedOpen
Post-Json '/installations/inst_exemplo/opens' $savedOpen # duplicate=true
$referral = Post-Json '/origins/tok_ref_crt123/resolve' @{ idempotency_key = 'example:referral:1' }
Post-Json '/installations/inst_exemplo/touches' @{
  touched_at = '2026-10-03T09:00:00.000Z'
  origin_token = 'tok_ref_crt123'
  click_id = $referral.click_id
}
Post-Json '/installations/inst_exemplo/signup' @{
  signup_id = 'signup_exemplo'
  signed_up_at = '2026-10-04T10:00:00.000Z'
} | ConvertTo-Json -Depth 10
Invoke-RestMethod "$base/signups/signup_exemplo/attribution" | ConvertTo-Json -Depth 10
```

Exemplo de request ao resolvedor:

```json
{"idempotency_key":"example:campaign:1","original_click_at":"2026-10-01T11:59:58.000Z"}
```

Resposta ilustrativa (o ID real é um UUID emitido pelo servidor e deve ser reutilizado):

```json
{
  "click_id": "clk_<uuid>",
  "origin_token": "tok_cmp_summer",
  "original_click_at": "2026-10-01T11:59:58.000Z",
  "deep_link": "https://app.example.test/open?origin_token=tok_cmp_summer&click_id=clk_<uuid>",
  "duplicate": false
}
```

Trecho da resposta de cadastro do fluxo de dois links (IDs abreviados, demais campos omitidos; `npm run demo` imprime a resposta completa):

```json
{
  "signup_id": "signup_exemplo",
  "origin": { "type": "referral", "id": "crt_123", "winning_click_id": "clk_referral" },
  "reason": "last_eligible_touch",
  "touches": [
    { "click_id": "clk_campaign", "eligible": true, "won": false, "reason": "superseded_by_later_touch" },
    { "click_id": "clk_referral", "eligible": true, "won": true, "reason": "last_eligible_touch" }
  ],
  "receipts": [
    { "click_id": "clk_campaign", "duplicate": false, "eligible": true, "won": false, "reason": "superseded_by_later_touch" },
    { "click_id": "clk_campaign", "duplicate": true, "eligible": false, "won": false, "reason": "duplicate_click" },
    { "click_id": "clk_referral", "duplicate": false, "eligible": true, "won": true, "reason": "last_eligible_touch" }
  ]
}
```

## Auditoria e orgânico

Cada toque original mostra token, identidade resolvida, `token_state`, `touched_at`, `original_click_at`, `received_at`, `recorded_after_signup`, `eligible`, `won` e `reason`. Recibos mostram a ordem de recebimento, payload de token/clique/horário e duplicidade; retries não contam como candidatos adicionais. A decisão também guarda a janela, regra de seleção, `decided_at` e corte de recibos.

| Motivo do toque | Significado |
|---|---|
| `last_eligible_touch` / `tie_break_click_id` | Venceu por horário / desempate ASCII |
| `superseded_by_later_touch` / `lost_tie_break` | Elegível, perdeu por horário / ID |
| `before_first_open` / `outside_window` | Antes da âncora / depois do fim dos 7 dias |
| `after_signup` | Horário posterior ao signup ou recebimento depois do cadastro |
| `invalid_token` / `inactive_token` | Token inexistente / desativado no recebimento |
| `unknown_click` / `click_token_mismatch` | Clique não emitido / emitido para outro token |
| `duplicate_click` | Retry antes do signup, guardado sem criar novo candidato |

Precedência de exclusão: posterior ao cadastro, estado inválido, antes do first open, fora da janela. Os recibos posteriores ao cadastro sempre mostram `after_signup`, conservando `duplicate` quando também forem replay. O estado do token é um snapshot no recebimento; não há revogação retroativa de origens nesta demo.

Sem vencedor, `origin.type=organic`, ID e clique vencedor nulos e motivo persistido: `no_touches`, `all_before_first_open`, `all_outside_window`, `all_after_signup`, `all_invalid_origins` ou `no_eligible_touches` quando as exclusões são mistas. Nenhum caso fica silenciosamente sem origem.

O banco contém `origin_tokens`, `resolved_clicks`, `installations`, `touches`, `touch_receipts` e `signups`. Chaves únicas e transações `BEGIN IMMEDIATE` serializam escrita e retry entre conexões. A aplicação congela o JSON da decisão; acesso direto ao arquivo SQLite é acesso administrativo, sem proteção contra edição manual do banco.

## Testes e limites

Os testes usam relógio injetado e verificam resolução idempotente, cliques distintos da mesma origem, ausência de referrer, atomicidade com falhas reais de inserção SQLite, primeiro open imutável, isolamento por instalação, dois links, empate em ordens diferentes, fronteiras de 1 ms, orgânico por todos os motivos, tokens/cliques inválidos, replay alterado, signup congelado, links retroativos recebidos depois e persistência após reabertura. A CI executa instalação limpa, typecheck, testes e demo em Node 22.23.3.

`opened_at`, `touched_at` e `signed_up_at` enviados pelo cliente são tratados como **confiáveis somente nesta demonstração**. `received_at` e `decided_at` vêm do relógio do servidor. Em produção, definiríamos relógio/SDK confiável, autenticação, identidade real da instalação, proteção e expiração de tokens, política de múltiplos aparelhos, consentimento/retenção e redirect/deferred deep link reais. Aqui os tokens seed são públicos e um clique emitido pode ser reproduzido noutra instalação: não há proteção contra fraude de identidade.

Sem frontend, OAuth, SDK móvel, app store, integração real de deep links nem serviço de campanha. O endpoint de resolução é a simulação explícita desse limite. A janela, desempate e prioridades poderiam mudar com requisitos do produto; estão centralizados na política.

## IA e revisão

A arquitetura, implementação, documentação e testes foram produzidos com apoio de IA (Codex). Foram executados typecheck, testes automatizados e demonstração HTTP em Node 22.23.3. A revisão independente de código foi feita por agentes de IA. **Marco não realizou revisão humana; revisão humana ainda não foi realizada.** Não houve envio do formulário da plataforma.
