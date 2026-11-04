# Guia: adicionar bulas novas

Como usar os scripts `npm run upload:bula` (um arquivo), `npm run upload:bulas` (lote) e `npm run upload:bulas -- <pasta> --registrar-existentes` (registro único das bulas legadas) para indexar bulas novas no Vector Store da OpenAI, que é a única fonte de informação que o MediBot usa para responder.

> **O Vector Store é compartilhado entre produção e Preview.** Um envio de verdade (sem `--dry-run`) afeta imediatamente o que o MediBot responde em produção, não só no seu ambiente de teste. Use `--dry-run` sempre que só quiser validar os arquivos, e confirme o `VECTOR_STORE_ID` antes de qualquer envio real.

## Onde colocar os PDFs

O repositório já tem uma pasta `bulas/` na raiz com todas as bulas atuais (ex.: `bulas/bula_ibuprofeno.pdf`). Coloque o PDF novo ali, seguindo o mesmo padrão de nome (abaixo). O script em si **não exige** que o arquivo esteja nessa pasta — ele aceita qualquer caminho que você passar — mas usar `bulas/` mantém tudo num lugar só e é o padrão já seguido pelos arquivos existentes.

## Padrão exato de nome do arquivo (e o que vira a "Fonte")

O nome do arquivo é a única informação usada para gerar a "Fonte" exibida nas respostas do assistente (texto citado ao usuário, ex.: `(Fontes consultadas nesta resposta: Ibuprofeno)`). Essa conversão é feita por `toReadableSourceName()` em `src/services/bulaSourceName.ts`, sem nenhuma edição manual depois do upload — por isso o nome do arquivo precisa já nascer certo.

Padrão usado pelos arquivos existentes e recomendado para os novos:

```
bula_<nome_do_medicamento>.pdf
```

Regras de como o nome do arquivo se transforma na "Fonte":
- A extensão é removida.
- O prefixo `bula` (seguido de espaço, `_` ou `-`) é removido, se existir — por isso o prefixo é opcional para o resultado final, mas mantenha-o por consistência com os arquivos já existentes.
- `_` e `-` viram espaço.
- Cada palavra é capitalizada (primeira letra maiúscula, resto minúsculo) — **inclusive conectores como "de"**, que também ficam com a inicial maiúscula (é uma limitação conhecida do conversor, não um bug a corrigir agora).
- Uma palavra que contém algum dígito é mantida exatamente como foi digitada (não é capitalizada nem alterada) — útil para algo como `750mg`.
- Acentos **não** são tratados: o conversor não remove nem adiciona acentuação. Os arquivos existentes evitam acento no nome do arquivo (ex.: `bula_losartana_potassica.pdf`, não `potássica`) — siga o mesmo padrão para a Fonte não sair com erro de acentuação.

Exemplos reais da pasta `bulas/`:

| Nome do arquivo | Fonte exibida |
|---|---|
| `bula_ibuprofeno.pdf` | Ibuprofeno |
| `bula_losartana_potassica.pdf` | Losartana Potassica |
| `bula_cloridrato_de_fluoxetina.pdf` | Cloridrato De Fluoxetina |
| `bula_simeticona_+_metilbrometo_de_homatropina.pdf` | Simeticona + Metilbrometo De Homatropina |

> **Atenção, regra mais estrita no envio em lote:** `npm run upload:bulas` (ver seção própria abaixo) exige literalmente `bula_<nome>.pdf`, minúsculo, com `<nome>` contendo só `a-z`, `0-9`, `_` ou `-` — sem acento, espaço ou qualquer outro caractere especial. O arquivo `bula_simeticona_+_metilbrometo_de_homatropina.pdf` (que já existe na pasta `bulas/`, enviado antes dessa regra existir) **não passaria** nessa checagem por causa do `+`; isso não afeta o que já foi enviado, só impede um reenvio dele pelo script em lote sem renomear.

## Como o `upload:bula` (um arquivo) recebe o arquivo

Um arquivo por vez — o script **não** aceita uma pasta inteira de uma vez. Uso:

```
npm run upload:bula -- <caminho-do-pdf> [vector-store-id]
```

- `<caminho-do-pdf>` é obrigatório (pode ser relativo, ex.: `bulas/bula_novo_medicamento.pdf`).
- `[vector-store-id]` é opcional; se omitido, usa a variável de ambiente `VECTOR_STORE_ID`.
- Para várias bulas novas, rode o comando uma vez para cada arquivo.

## O que o `upload:bula` valida

Só três checagens, nessa ordem, e qualquer uma delas interrompe o envio antes de chamar a OpenAI:
1. Um caminho de arquivo foi passado como argumento.
2. O arquivo existe no caminho informado (resolvido a partir do diretório atual).
3. A extensão do arquivo é `.pdf` (case-insensitive).

**Não valida tamanho do arquivo** — não há limite verificado localmente; se o arquivo for grande demais para a API da OpenAI, o erro vem de lá (não do script).

**Não valida duplicados** — o script não checa se já existe uma bula com aquele nome ou conteúdo no Vector Store. Ver seção abaixo.

## O que o `upload:bula` imprime em caso de sucesso e de erro

**Sucesso**, nesta ordem:
```
Enviando a bula para a OpenAI e aguardando a indexação...
Bula indexada com sucesso.
```
(a segunda linha só aparece depois que a indexação é concluída — o comando espera, pode levar alguns segundos).

**Erro**: o script não tem nenhum `try/catch` — qualquer falha é um `throw new Error(...)` que não é capturado, então o Node imprime a stack trace completa no terminal (não é uma mensagem limpa de "Erro: ..."). As mensagens possíveis, dentro da stack trace, são:
- `Uso: npm run upload:bula -- <caminho-do-pdf> [vector-store-id]` — faltou o caminho do arquivo.
- `Arquivo não encontrado: <caminho-resolvido>` — caminho errado ou arquivo não existe.
- `A fonte de conhecimento deve ser um arquivo PDF.` — extensão diferente de `.pdf`.
- `VECTOR_STORE_ID não foi informado. Passe-o como argumento ou configure-o no .env.` — vem de `getVectorStoreId()` (`src/config.ts`), se nem o argumento nem a variável de ambiente estiverem definidos.
- `A indexação falhou: <mensagem ou status da OpenAI>` — o upload chegou na OpenAI, mas a indexação não terminou com status `completed` (ex.: PDF corrompido, ilegível, ou erro da própria API).

Em todos os casos, o processo termina com código de saída diferente de zero (falha).

## Como saber se uma bula já foi enviada (`upload:bula`, um arquivo)

O `upload:bula` não tem manifesto nem lista os arquivos do Vector Store. Duas formas práticas de checar antes de rodá-lo:
1. **Dashboard da OpenAI** (platform.openai.com → Storage → Vector stores → o store com o ID de `VECTOR_STORE_ID`): lista todos os arquivos já enviados, pelo nome exato. É a forma confiável de ver se um nome de arquivo específico já está lá (inclusive duplicados).
2. **`npm run search:bula -- "pergunta sobre o medicamento"`**: roda uma pergunta de teste contra o Vector Store e imprime, no final, as "Fontes" usadas na resposta. Se o nome esperado aparecer ali, o conteúdo está indexado e sendo encontrado pela busca — mas isso é um teste funcional, não uma lista de arquivos, e não revela duplicados.

Usando `npm run upload:bulas` (seção abaixo) isso fica automático: o manifesto `bulas/uploaded.json` já sabe o que foi enviado e pula de novo.

## O que acontece ao reenviar a mesma bula pelo `upload:bula`

O script sempre faz um **upload novo**: ele não verifica se o conteúdo ou o nome já existem no Vector Store antes de enviar. Reenviar o mesmo PDF (mesmo nome, mesmo conteúdo) cria um **segundo arquivo independente** dentro do Vector Store — a OpenAI não substitui nem remove o anterior automaticamente. Resultado prático:
- O Vector Store passa a ter duas cópias indexadas do mesmo conteúdo (desperdiça espaço/custo).
- Nas respostas do assistente isso não aparece duplicado por acaso: `dedupeReadableNames()` (`src/services/bulaService.ts`) agrupa as fontes pelo nome legível final, então a lista de "Fontes" mostrada ao usuário continua mostrando o nome uma única vez.
- Se a ideia era **substituir** uma bula por uma versão corrigida, reenviar não resolve por si só — o arquivo antigo continua indexado e pode ser escolhido pela busca. Isso exigiria remover o arquivo antigo do Vector Store manualmente pelo dashboard da OpenAI (nenhum dos dois scripts faz isso hoje).

O `upload:bulas` evita esse problema específico: ele rejeita, antes de enviar, um arquivo cujo conteúdo (SHA-256) já esteja no manifesto com outro nome — mas não é capaz de "atualizar" uma bula existente, só de recusar reenviar o mesmo conteúdo. Substituir continua sendo manual (dashboard da OpenAI).

## Envio em lote (`npm run upload:bulas`)

Para enviar várias bulas de uma vez, em sequência, com validação, manifesto de controle e retomada após erro. Mantém o `upload:bula` (um arquivo) funcionando sem nenhuma mudança — são dois scripts independentes.

```
npm run upload:bulas -- <pasta> [--dry-run]
```

- `<pasta>` é obrigatória: processa **todos** os `.pdf` dentro dela (não entra em subpastas), um por vez, em sequência, com uma pequena pausa entre arquivos.
- `--dry-run` roda todas as validações e mostra o que aconteceria, **sem enviar nada para a OpenAI e sem precisar de `OPENAI_API_KEY`/`VECTOR_STORE_ID` configuradas**. Use sempre que só quiser revisar nomes/Fontes/duplicados.
- Sem `--dry-run`, o comando realmente envia os arquivos válidos — e isso afeta o Vector Store compartilhado com produção (ver aviso no topo deste guia).

### Validações (rodam sempre, mesmo em `--dry-run`, antes de qualquer envio)

Para cada arquivo, nessa ordem:
1. Já está no manifesto (mesmo nome de arquivo, **de qualquer origem — enviado por este script ou registrado como legado**) → marcado como **pulado** ("já enviado"), nem chega a ser lido nem passa pela validação de nome abaixo. Isso é o que permite um nome antigo fora do padrão (ex.: com `+`) continuar na pasta sem dar erro, desde que já esteja no manifesto.
2. (Só para quem ainda não está no manifesto) Nome no padrão `bula_<nome>.pdf` (minúsculo, só `a-z`/`0-9`/`_`/`-`, sem acento/espaço/caractere especial) → senão **erro**.
3. Começa com a assinatura `%PDF-` e tem tamanho entre 10 KB e 20 MB → senão **erro**.
4. Conteúdo (SHA-256) já presente no manifesto com outro nome → **erro** (duplicado já enviado antes).
5. Dentro do próprio lote: dois arquivos com o mesmo SHA-256, ou dois nomes diferentes que gerariam a mesma "Fonte" (ex.: `bula_dipirona_sodica.pdf` e `bula_dipirona-sodica.pdf` viram ambos "Dipirona Sodica") → **erro** nos dois.
6. A "Fonte" do arquivo novo coincide com a Fonte de alguma entrada já no manifesto (enviada ou legada) **com um conteúdo (SHA-256) diferente** → **aviso**, não erro: `AVISO: já existe uma bula com a Fonte "X": confirme que não é duplicada`. Isso não bloqueia o envio — pode ser só uma correção/atualização da mesma bula, então a decisão final é sua. O resumo final conta quantos arquivos tiveram algum aviso.

O comando sempre imprime uma tabela com nome do arquivo, a "Fonte" calculada e o status de cada um (mais os avisos, quando houver), para revisão, antes de decidir se vai enviar (em `--dry-run`, é só isso — nada é enviado depois).

### Manifesto `bulas/uploaded.json`

Arquivo JSON versionável (deve ser commitado) com uma entrada por bula conhecida: nome do arquivo, SHA-256, data/hora e `origin` — `"upload"` (enviada de verdade por este script, com o `openaiFileId` da OpenAI) ou `"legado"` (já estava no Vector Store antes do manifesto existir, só registrada via `--registrar-existentes`, sem `openaiFileId`). É **gravado de novo a cada sucesso** (envio ou registro, não só no final), então uma falha no meio não perde o progresso já salvo. Ele só existe depois do primeiro envio real ou do primeiro `--registrar-existentes` — não é criado em `--dry-run`.

### Primeira vez (uma única vez): registrar as bulas legadas (`--registrar-existentes`)

As bulas que já estavam em `bulas/` foram enviadas ao Vector Store **antes de o manifesto existir**. Sem registrá-las primeiro, o primeiro `upload:bulas` normal nessa pasta tentaria reenviá-las todas, duplicando-as no Vector Store. Este comando resolve isso sem precisar reenviar nada:

```
npm run upload:bulas -- bulas --registrar-existentes
```

- **Nunca chama a OpenAI nem exige `OPENAI_API_KEY`/`VECTOR_STORE_ID`** — só calcula o SHA-256 de cada PDF da pasta e grava no manifesto com `origin: "legado"` (sem `openaiFileId`, com a data do registro — não a data do envio original, que o script não tem como saber).
- **Não aplica a validação estrita de nome** (`bula_<nome>.pdf` minúsculo/sem acento) — aceita os nomes antigos como estão, inclusive o único arquivo com `+` no nome. Só precisa realmente ser um PDF (`%PDF-`).
- **É seguro rodar mais de uma vez**: um arquivo cujo nome (ou, por garantia extra, cujo conteúdo) já está no manifesto é contado como "já estava no manifesto" e não gera uma segunda entrada.
- Imprime uma linha `REGISTRADO: "arquivo" (Fonte: "X")` para cada um, e no final um resumo com quantos foram registrados agora, quantos já estavam, e quantos deram erro (ex.: um arquivo que não é um PDF de verdade).

**Quando rodar:** uma única vez, por quem tiver o repositório atualizado (a pasta `bulas/` com todos os arquivos atuais), **antes do primeiro `upload:bulas` normal** nessa pasta. Depois disso, **`bulas/uploaded.json` precisa ir para o git** — é esse arquivo commitado que faz todo mundo (e o CI, se houver) parar de tentar reenviar os legados. Quem já tiver essa versão do manifesto não precisa rodar de novo.

### Passo a passo: só validar, sem chave (`--dry-run`)

1. Se ainda não foi feito neste repositório, rode o registro de legados (seção anterior) e confira que `bulas/uploaded.json` existe e está commitado.
2. Coloque os PDFs novos numa pasta (ex.: `bulas/`), já com o nome `bula_<nome>.pdf` correto.
3. Rode `npm run upload:bulas -- bulas --dry-run`.
4. Leia a tabela impressa: os arquivos antigos devem aparecer como `pulado`; confira a "Fonte" de cada arquivo novo e resolva qualquer linha de **erro** (nome fora do padrão, PDF inválido, duplicado) e leia os **avisos** (Fonte repetida) antes de seguir.
5. Repita até a tabela não mostrar mais erros nos arquivos que você quer enviar.

### Passo a passo: envio de verdade

1. Garanta que `OPENAI_API_KEY` e `VECTOR_STORE_ID` estão configuradas no ambiente (nunca o do Supabase/produção de outra coisa — confirme que é o Vector Store certo).
2. Rode o mesmo `--dry-run` primeiro (passo anterior) e só prossiga se a tabela estiver limpa (e tiver revisado os avisos, se houver).
3. Rode `npm run upload:bulas -- bulas` (sem `--dry-run`).
4. Acompanhe a saída: cada sucesso imprime uma linha `OK: ...`, cada falha uma linha `ERRO: ...` com mensagem em português (sem stack trace, sem a chave).
5. No final, leia o resumo (`Enviados` / `Pulados` / `Com erro` / `Avisos`) e confira que `bulas/uploaded.json` foi atualizado (`git status`/`git diff`) — e **comite esse arquivo** junto com o restante do trabalho, para a próxima pessoa saber o que já foi enviado.

### Se der erro no meio do lote

O lote **continua** para os arquivos seguintes mesmo depois de um erro (não para tudo por causa de um arquivo problemático), e tenta de novo automaticamente uma vez quando o erro parece transitório (rede instável, limite de taxa, erro 5xx da OpenAI). No final, o resumo mostra quantos tiveram erro, e o processo termina com código de saída diferente de zero (útil em CI/scripts).

Para retomar: resolva o problema do(s) arquivo(s) com erro (renomeie, cheque o PDF, etc.) e **rode o mesmo comando de novo, com a mesma pasta**. Os arquivos que já foram enviados com sucesso estão no manifesto e serão pulados automaticamente ("já enviado") — só os que falharam (ou os novos que você adicionou) serão processados.

## Variáveis do `.env.local` necessárias

Só os nomes (sem valores):
- `OPENAI_API_KEY`
- `VECTOR_STORE_ID` (no `upload:bula`, pode ser substituída por um argumento na linha de comando; uma das duas formas é obrigatória. No `upload:bulas`, só a variável de ambiente, sem argumento equivalente)

**Nenhuma das duas é necessária para `npm run upload:bulas -- <pasta> --dry-run`** — esse é o ponto de rodar só com `--dry-run`: valida tudo sem exigir a chave nem o id do Vector Store.

## Checklist pós-upload (5 itens)

Vale para depois de um envio de verdade, por qualquer um dos dois scripts:

1. O comando terminou sem indicar erro: `Bula indexada com sucesso.` (`upload:bula`) ou resumo com `Com erro: 0` (`upload:bulas`).
2. No dashboard da OpenAI (Vector store → Files), o(s) arquivo(s) novo(s) aparecem com o nome esperado, sem reaparecer duplicado.
3. `npm run search:bula -- "pergunta sobre o medicamento novo"` devolve uma resposta baseada na bula nova (não a mensagem de "informação não encontrada").
4. A seção "Fontes" dessa resposta mostra o nome legível esperado (ex.: "Ibuprofeno"), confirmando que o nome do arquivo ficou correto.
5. Uma pergunta sobre um medicamento **diferente**, já existente antes, continua respondendo normalmente (confirma que o upload novo não afetou os outros). Se usou `upload:bulas`, confirme também que `bulas/uploaded.json` foi atualizado e está para commit.
