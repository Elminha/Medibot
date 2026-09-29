# 💊 Medibot

### Chatbot de Apoio à Compreensão de Bulas

Assistente baseado em **RAG (Retrieval-Augmented Generation) + OpenAI**, desenvolvido para facilitar a compreensão de informações presentes em bulas de medicamentos, utilizando uma linguagem mais simples e acessível.

> **“Entenda sua bula em segundos, sem termos difíceis.”**

---

## 📌 Sobre o projeto

O **Medibot** é um projeto desenvolvido como parte do **Trabalho de Conclusão de Curso II (TCC 2026)** do curso de Sistemas de Informação do **Centro Universitário Unieuro**.

O projeto busca solucionar uma dificuldade comum: as bulas de medicamentos apresentam diversos termos técnicos que podem ser difíceis de compreender para pessoas sem conhecimento na área da saúde.

A proposta é utilizar **Inteligência Artificial** para recuperar informações diretamente das bulas cadastradas e apresentar essas informações de forma **mais simples, clara e acessível**, preservando o significado do conteúdo original.

O sistema é disponibilizado como uma **aplicação web**, permitindo que o usuário faça perguntas sobre medicamentos utilizando linguagem natural e organize os medicamentos que acompanha.

---

## 🎯 Objetivo

Desenvolver um assistente conversacional capaz de auxiliar pacientes e cuidadores na compreensão de informações presentes em bulas de medicamentos, fornecendo respostas fundamentadas no conteúdo oficial das bulas cadastradas.

### Objetivos específicos

* 📚 Criar uma base de conhecimento a partir de bulas selecionadas;
* 🔎 Utilizar busca semântica para recuperar informações relevantes;
* 🤖 Implementar uma arquitetura RAG utilizando a API da OpenAI;
* 🗣️ Simplificar termos médicos e técnicos para uma linguagem mais acessível;
* 🛡️ Reduzir o risco de respostas não fundamentadas na bula;
* ⚠️ Delimitar perguntas que estejam fora do escopo do sistema;
* 💊 Permitir o cadastro de medicamentos e lembretes de horário;
* ⏰ Implementar lembretes de medicação.

---

## 🧠 Arquitetura RAG

O Medibot utiliza **RAG (Retrieval-Augmented Generation)** para fundamentar as respostas nas informações presentes nas bulas cadastradas.

A implementação utiliza o **Vector Store da API da OpenAI**. O serviço realiza o processamento dos arquivos, incluindo divisão e indexação dos conteúdos, e permite recuperar semanticamente os trechos relevantes para uma determinada pergunta.

### Fluxo atual

```text
Bula em PDF
     ↓
Upload para o Vector Store (OpenAI)
     ↓
Indexação / embeddings
     ↓
Pergunta do usuário (via API /api/bula)
     ↓
Busca semântica
     ↓
Trechos relevantes da bula
     ↓
Modelo OpenAI (gpt-4o-mini)
     ↓
Resposta simplificada
```

Essa abordagem permite que o modelo utilize o conteúdo recuperado da bula como contexto para gerar a resposta.

---

## 🔎 Vector Store (OpenAI)

O **Vector Store** é o componente responsável pela recuperação das informações das bulas.

Os documentos são importados para um Vector Store, onde seus conteúdos são processados e representados por embeddings. Quando uma pergunta é realizada, a consulta também é analisada semanticamente para localizar os trechos mais relevantes.

Isso permite que o usuário faça perguntas utilizando palavras diferentes das utilizadas originalmente na bula.

### Exemplo

Pergunta:

```text
Quais são as reações ruins que esse remédio pode causar?
```

O sistema pode recuperar informações relacionadas à seção:

```text
Reações adversas
```

Mesmo que o usuário não utilize exatamente o termo presente na bula.

---

## 🤖 OpenAI

O projeto utiliza o **SDK oficial `openai`** para comunicação com a API da OpenAI.

A configuração atual utiliza:

```text
Modelo: gpt-4o-mini
```

O modelo é responsável pela geração das respostas a partir das informações recuperadas pelo Vector Store.

O projeto também permite definir outro modelo através da variável `OPENAI_MODEL`.

---

## 🗣️ Simplificação da linguagem

Uma das principais funcionalidades do Medibot é transformar informações técnicas presentes nas bulas em explicações mais fáceis de compreender.

### Exemplo

**Termo técnico:**

```text
Choque anafilático
```

**Explicação simplificada:**

```text
Uma reação alérgica muito grave que pode causar dificuldade
para respirar, queda da pressão e risco à vida.
```

O objetivo é **facilitar a compreensão sem alterar o significado da informação original**.

---

## 🛡️ Segurança e limites

O Medibot é uma ferramenta de **apoio à compreensão de informações presentes em bulas** e não substitui profissionais de saúde.

O sistema não deve:

* realizar diagnósticos;
* prescrever medicamentos;
* recomendar tratamentos personalizados;
* alterar doses;
* recomendar a suspensão de medicamentos;
* interpretar exames;
* realizar avaliação clínica.

Perguntas que estejam fora do escopo definido para o sistema deverão ser tratadas de forma segura, informando ao usuário a limitação da ferramenta.

---

## 🚧 Status do projeto

### ✅ Implementado

* [x] Estrutura inicial do projeto
* [x] Configuração do Node.js + TypeScript
* [x] Integração com a API da OpenAI
* [x] Configuração do modelo OpenAI
* [x] Upload de bula em PDF
* [x] Criação/utilização do Vector Store da OpenAI
* [x] Recuperação semântica de informações das bulas
* [x] Implementação do fluxo de busca RAG
* [x] Geração de respostas utilizando a OpenAI
* [x] Simplificação de termos médicos
* [x] Backend/API do sistema (Express + TypeScript)
* [x] Banco de dados PostgreSQL (hospedado no Supabase)
* [x] Cadastro de medicamentos
* [x] Cadastro de lembretes
* [x] Interface web para consulta de bulas
* [x] Deploy em produção (Vercel)
* [x] Configuração de variáveis de ambiente
* [x] Proteção das credenciais através do `.gitignore`

### 🔨 Em desenvolvimento

* [ ] Regras completas de delimitação de escopo
* [ ] Indicação da fonte utilizada na resposta
* [ ] Cadastro/autenticação de usuários
* [ ] Scheduler para notificações de lembretes
* [ ] Deploy automático a partir da branch `develop` (homologação)

### 📋 Futuramente

* [ ] Histórico de conversas
* [ ] Painel de gerenciamento das bulas
* [ ] Ampliação da base de medicamentos
* [ ] Testes com usuários
* [ ] Avaliação de fidelidade das respostas
* [ ] Avaliação da satisfação dos usuários

> **Nota:** o projeto inicialmente previa integração com o WhatsApp Business API (Meta Cloud API). Essa integração foi descontinuada devido à complexidade de aprovação/verificação de conta exigida pela Meta para uso fora do modo de teste, e o sistema passou a ser disponibilizado como uma aplicação web.

---

## 🛠️ Tecnologias

### Utilizadas atualmente

| Tecnologia          | Utilização                                      |
| -------------------- | ----------------------------------------------- |
| **Node.js**          | Ambiente de execução                            |
| **TypeScript**       | Desenvolvimento da aplicação                    |
| **Express**          | Backend/API                                     |
| **OpenAI API**       | Inteligência Artificial e geração das respostas |
| **gpt-4o-mini**      | Modelo de linguagem utilizado atualmente        |
| **OpenAI Vector Store** | Recuperação semântica das informações das bulas |
| **PostgreSQL**       | Usuários, medicamentos, lembretes e registros   |
| **Supabase**         | Hospedagem do banco PostgreSQL                  |
| **Vercel**           | Hospedagem/deploy da aplicação                  |
| **Git**              | Controle de versão                              |
| **GitHub**           | Hospedagem do código                            |

### Tecnologias previstas

| Tecnologia             | Utilização                     |
| ----------------------- | ------------------------------- |
| **BullMQ / node-cron**  | Agendamento de notificações     |

---

## 📁 Estrutura do projeto

```text
medibot/
│
├── api/
│   └── index.ts              # Entry point serverless (Vercel)
│
├── bulas/
│   ├── bula_dipirona.pdf
│   └── ...
│
├── public/
│   ├── index.html
│   ├── app.js
│   └── styles.css
│
├── src/
│   ├── askBula.ts
│   ├── config.ts
│   ├── createVectorStore.ts
│   ├── searchBula.ts
│   ├── uploadBula.ts
│   ├── server.ts
│   ├── database/
│   │   ├── database.ts
│   │   ├── migrate.ts
│   │   └── migrations/
│   ├── routes/
│   │   ├── bulaRoutes.ts
│   │   ├── medicationRoutes.ts
│   │   └── reminderRoutes.ts
│   └── services/
│       ├── bulaService.ts
│       ├── medicationService.ts
│       └── reminderService.ts
│
├── .env.example
├── .gitignore
├── vercel.json
├── package.json
├── package-lock.json
└── tsconfig.json
```

### Principais arquivos

| Arquivo                | Responsabilidade                                                  |
| ----------------------- | ------------------------------------------------------------------ |
| `config.ts`             | Configuração da OpenAI, modelo e Vector Store                     |
| `uploadBula.ts`         | Upload das bulas para o Vector Store                               |
| `createVectorStore.ts`  | Criação/configuração do armazenamento utilizado pelo Vector Store  |
| `searchBula.ts`         | Realização das consultas nas bulas                                 |
| `askBula.ts`            | Geração das respostas utilizando a OpenAI                          |
| `server.ts`             | Servidor Express e rotas da API                                    |
| `database.ts`           | Conexão com o PostgreSQL (Supabase)                                |
| `bulaService.ts`        | Lógica de consulta RAG usada pela rota `/api/bula`                 |

---

## ⚙️ Configuração

### 1. Clone o repositório

```bash
git clone https://github.com/Elminha/Medibot.git
cd Medibot
```

### 2. Instale as dependências

```bash
npm install
```

### 3. Configure as variáveis de ambiente

Crie um arquivo `.env` na raiz do projeto (veja `.env.example` como referência):

```env
OPENAI_API_KEY=sua_chave_aqui
VECTOR_STORE_ID=seu_vector_store_id
OPENAI_MODEL=gpt-4o-mini
PORT=3000

# Produção (ex.: Supabase) — tem prioridade sobre as variáveis abaixo
# DATABASE_URL=postgresql://usuario:senha@host:porta/postgres

# Desenvolvimento local (ignoradas se DATABASE_URL estiver definida)
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=medibot
DATABASE_USER=postgres
DATABASE_PASSWORD=
```

### Variáveis

| Variável           | Descrição                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `OPENAI_API_KEY`    | Chave de acesso à API da OpenAI                                  |
| `VECTOR_STORE_ID`   | Identificação do Vector Store utilizado para consultar as bulas |
| `OPENAI_MODEL`      | Modelo da OpenAI utilizado pelo sistema                          |
| `DATABASE_URL`      | Connection string do PostgreSQL (recomendada em produção)       |
| `DATABASE_HOST/PORT/NAME/USER/PASSWORD` | Configuração alternativa do PostgreSQL, usada em desenvolvimento local |

> ⚠️ **Nunca compartilhe ou envie o arquivo `.env` para o GitHub.** As credenciais devem permanecer protegidas. O arquivo `.env` já está incluído no `.gitignore` deste projeto.

### 4. Rode as migrations do banco

```bash
npm run db:migrate
```

### 5. Rode o projeto localmente

```bash
npm run dev
```

---

## ▶️ Executando o projeto

### Compilar o projeto

```bash
npm run build
```

### Fazer uma consulta à bula (via CLI)

```bash
npm run ask:bula -- "Quais são as contraindicações da dipirona?"
```

### Consultar via API (com o servidor rodando)

```bash
curl -X POST http://localhost:3000/api/bula \
  -H "Content-Type: application/json" \
  -d '{"question":"Quais são as contraindicações da dipirona?"}'
```

O sistema realiza a busca no **Vector Store da OpenAI** e utiliza as informações recuperadas para gerar uma resposta utilizando o modelo configurado.

---

## 🌐 Deploy

O projeto está hospedado na **Vercel**, com banco de dados **PostgreSQL** hospedado no **Supabase**.

* **Produção:** https://medibot-amber.vercel.app
* **Backend:** Express adaptado para rodar como função serverless (`api/index.ts` + `vercel.json`)
* **Banco de dados:** Supabase (PostgreSQL), conectado via `DATABASE_URL` com SSL

---

## 📚 Exemplo de funcionamento

### Pergunta

```text
Quais são as contraindicações da dipirona?
```

### Fluxo

```text
Usuário
   ↓
Pergunta
   ↓
Vector Store (OpenAI)
   ↓
Busca semântica na bula
   ↓
Trechos relevantes
   ↓
Modelo OpenAI
   ↓
Simplificação
   ↓
Resposta
```

---

## 📖 Fonte das informações

A base de conhecimento do projeto é composta por **bulas previamente cadastradas**.

O objetivo do RAG é utilizar os conteúdos recuperados desses documentos como contexto para a geração das respostas.

No desenvolvimento atual, a indicação explícita da fonte na resposta está prevista como uma etapa de evolução do projeto.

---

## ⚠️ Aviso

O Medibot possui finalidade **informativa e educacional**.

As respostas são baseadas nas bulas cadastradas no sistema e não substituem a avaliação de médicos, farmacêuticos ou outros profissionais de saúde.

O sistema não deve ser utilizado para diagnóstico, prescrição, alteração de dose ou decisão de suspensão de medicamentos.

Em situações de emergência ou diante de sintomas graves, o usuário deve procurar atendimento profissional.

---

## 🎓 Projeto acadêmico

Este projeto está sendo desenvolvido como parte do:

**Trabalho de Conclusão de Curso II — TCC 2026**

**Curso:** Sistemas de Informação
**Instituição:** Centro Universitário Unieuro
**Orientador:** Prof. Éfrem Filho

---

## 👥 Equipe

* **Jeielma Dias** — Desenvolvimento
* **Daniel Jreige** — Desenvolvimento
* **Leandro Côrtes** — Desenvolvimento
* **Paulo Henrique** — Desenvolvimento

---

## 📌 Próximos passos

O desenvolvimento do Medibot seguirá as próximas etapas previstas no projeto:

1. 🛡️ Aperfeiçoar a delimitação de escopo;
2. 📚 Melhorar a indicação das fontes das respostas;
3. 🔐 Implementar cadastro/autenticação de usuários;
4. ⏰ Desenvolver o sistema de lembretes;
5. 🔔 Implementar as notificações automáticas;
6. 🧪 Realizar testes e validação com usuários;
7. 📊 Avaliar a fidelidade das respostas e a satisfação dos usuários.

---

## 📄 Licença

Este projeto possui finalidade **acadêmica** e está sendo desenvolvido como parte do Trabalho de Conclusão de Curso II.
