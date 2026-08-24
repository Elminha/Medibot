# 💊 Medibot

### Chatbot de Apoio à Compreensão de Bulas

Assistente baseado em **RAG (Retrieval-Augmented Generation) + Google Gemini**, desenvolvido para facilitar a compreensão de informações presentes em bulas de medicamentos, utilizando uma linguagem mais simples e acessível.

> **“Entenda sua bula em segundos, sem termos difíceis — e nunca mais esqueça o horário do remédio, direto no WhatsApp.”**

---

## 📌 Sobre o projeto

O **Medibot** é um projeto desenvolvido como parte do **Trabalho de Conclusão de Curso II (TCC 2026)** do curso de Sistemas de Informação do **Centro Universitário Unieuro**.

O projeto busca solucionar uma dificuldade comum: as bulas de medicamentos apresentam diversos termos técnicos que podem ser difíceis de compreender para pessoas sem conhecimento na área da saúde.

A proposta é utilizar **Inteligência Artificial** para recuperar informações diretamente das bulas cadastradas e apresentar essas informações de forma **mais simples, clara e acessível**, preservando o significado do conteúdo original.

Em sua versão final, o sistema será disponibilizado por meio do **WhatsApp**, permitindo que o usuário faça perguntas sobre medicamentos utilizando linguagem natural.

---

## 🎯 Objetivo

Desenvolver um assistente conversacional capaz de auxiliar pacientes e cuidadores na compreensão de informações presentes em bulas de medicamentos, fornecendo respostas fundamentadas no conteúdo oficial das bulas cadastradas.

### Objetivos específicos

* 📚 Criar uma base de conhecimento a partir de bulas selecionadas;
* 🔎 Utilizar busca semântica para recuperar informações relevantes;
* 🤖 Implementar uma arquitetura RAG utilizando o Google Gemini;
* 🗣️ Simplificar termos médicos e técnicos para uma linguagem mais acessível;
* 🛡️ Reduzir o risco de respostas não fundamentadas na bula;
* ⚠️ Delimitar perguntas que estejam fora do escopo do sistema;
* 💬 Disponibilizar o atendimento futuramente pelo WhatsApp;
* ⏰ Implementar futuramente lembretes de medicação.

---

## 🧠 Arquitetura RAG

O Medibot utiliza **RAG (Retrieval-Augmented Generation)** para fundamentar as respostas nas informações presentes nas bulas cadastradas.

A implementação utiliza o **File Search da API Gemini**. O serviço realiza o processamento dos arquivos, incluindo divisão e indexação dos conteúdos, e permite recuperar semanticamente os trechos relevantes para uma determinada pergunta.

### Fluxo atual

```text
Bula em PDF
     ↓
Upload para o Gemini File Search
     ↓
File Search Store
     ↓
Indexação / embeddings
     ↓
Pergunta do usuário
     ↓
Busca semântica
     ↓
Trechos relevantes da bula
     ↓
Gemini 2.5 Flash
     ↓
Resposta simplificada
```

Essa abordagem permite que o modelo utilize o conteúdo recuperado da bula como contexto para gerar a resposta.

---

## 🔎 Gemini File Search

O **File Search** é o componente responsável pela recuperação das informações das bulas.

Os documentos são importados para um **File Search Store**, onde seus conteúdos são processados e representados por embeddings. Quando uma pergunta é realizada, a consulta também é analisada semanticamente para localizar os trechos mais relevantes.

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

## 🤖 Google Gemini

O projeto utiliza a biblioteca oficial **`@google/genai`** para comunicação com a API Gemini.

A configuração atual utiliza:

```text
Modelo: gemini-2.5-flash
```

O modelo é responsável pela geração das respostas a partir das informações recuperadas pelo File Search.

O projeto também permite definir outro modelo através da variável `GEMINI_MODEL`.

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
* [x] Integração com a API do Google Gemini
* [x] Configuração do modelo Gemini
* [x] Upload de bula em PDF
* [x] Criação/utilização do Gemini File Search Store
* [x] Recuperação semântica de informações das bulas
* [x] Implementação do fluxo de busca RAG
* [x] Geração de respostas utilizando o Gemini
* [x] Simplificação de termos médicos
* [x] Configuração de variáveis de ambiente
* [x] Proteção das credenciais através do `.gitignore`

### 🔨 Em desenvolvimento

* [ ] Regras completas de delimitação de escopo
* [ ] Indicação da fonte utilizada na resposta
* [ ] Integração com WhatsApp
* [ ] Backend/API do sistema
* [ ] Banco de dados PostgreSQL
* [ ] Cadastro de usuários
* [ ] Cadastro de lembretes
* [ ] Scheduler para notificações
* [ ] Envio automático de lembretes pelo WhatsApp

### 📋 Futuramente

* [ ] Histórico de conversas
* [ ] Painel de gerenciamento das bulas
* [ ] Ampliação da base de medicamentos
* [ ] Testes com usuários
* [ ] Avaliação de fidelidade das respostas
* [ ] Avaliação da satisfação dos usuários

---

## 🛠️ Tecnologias

### Utilizadas atualmente

| Tecnologia             | Utilização                                      |
| ---------------------- | ----------------------------------------------- |
| **Node.js**            | Ambiente de execução                            |
| **TypeScript**         | Desenvolvimento da aplicação                    |
| **Google Gemini API**  | Inteligência Artificial e geração das respostas |
| **Gemini 2.5 Flash**   | Modelo de linguagem utilizado atualmente        |
| **Gemini File Search** | Recuperação semântica das informações das bulas |
| **`@google/genai`**    | SDK utilizado para integração com a API Gemini  |
| **Git**                | Controle de versão                              |
| **GitHub**             | Hospedagem do código                            |

### Tecnologias previstas

| Tecnologia                | Utilização                                    |
| ------------------------- | --------------------------------------------- |
| **WhatsApp Business API** | Comunicação com os usuários                   |
| **PostgreSQL**            | Usuários, medicamentos, lembretes e registros |
| **BullMQ / node-cron**    | Agendamento de notificações                   |
| **Railway / Render**      | Hospedagem da aplicação                       |

---

## 📁 Estrutura do projeto

```text
medibot/
│
├── bulas/
│   ├── bula_dipirona.pdf
│   └── .gitkeep
│
├── src/
│   ├── askBula.ts
│   ├── config.ts
│   ├── createVectorStore.ts
│   ├── searchBula.ts
│   └── uploadBula.ts
│
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
└── tsconfig.json
```

### Principais arquivos

| Arquivo                | Responsabilidade                                                 |
| ---------------------- | ---------------------------------------------------------------- |
| `config.ts`            | Configuração do Gemini, modelo e File Search Store               |
| `uploadBula.ts`        | Upload das bulas para o File Search                              |
| `createVectorStore.ts` | Criação/configuração do armazenamento utilizado pelo File Search |
| `searchBula.ts`        | Realização das consultas nas bulas                               |
| `askBula.ts`           | Geração das respostas utilizando o Gemini                        |

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

Crie um arquivo `.env` na raiz do projeto:

```env
GEMINI_API_KEY=sua_chave_aqui
GEMINI_MODEL=gemini-2.5-flash
FILE_SEARCH_STORE_NAME=seu_file_search_store_name
```

### Variáveis

| Variável                 | Descrição                                                                        |
| ------------------------ | -------------------------------------------------------------------------------- |
| `GEMINI_API_KEY`         | Chave de acesso à API Gemini                                                     |
| `GEMINI_MODEL`           | Modelo Gemini utilizado pelo sistema                                             |
| `FILE_SEARCH_STORE_NAME` | Identificação do File Search Store utilizado para armazenar e consultar as bulas |

> ⚠️ **Nunca compartilhe ou envie o arquivo `.env` para o GitHub.** As credenciais devem permanecer protegidas. O arquivo `.env` já está incluído no `.gitignore` deste projeto.

---

## ▶️ Executando o projeto

### Compilar o projeto

```bash
npm run build
```

### Fazer uma consulta à bula

```bash
npm run search:bula -- "Quais são as contraindicações da dipirona?"
```

O sistema realiza a busca no **Gemini File Search** e utiliza as informações recuperadas para gerar uma resposta utilizando o modelo Gemini.

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
Gemini File Search
   ↓
Busca semântica na bula
   ↓
Trechos relevantes
   ↓
Gemini 2.5 Flash
   ↓
Simplificação
   ↓
Resposta
```

---

## 📖 Fonte das informações

A base de conhecimento do projeto é composta por **bulas previamente cadastradas**.

O objetivo do RAG é utilizar os conteúdos recuperados desses documentos como contexto para a geração das respostas.

O Gemini File Search também possui suporte a informações de citação associadas aos documentos utilizados na resposta, permitindo identificar a origem do conteúdo recuperado.

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
3. 💬 Integrar o sistema ao WhatsApp;
4. 🗄️ Implementar o banco de dados;
5. ⏰ Desenvolver o sistema de lembretes;
6. 🔔 Implementar as notificações automáticas;
7. 🧪 Realizar testes e validação com usuários;
8. 📊 Avaliar a fidelidade das respostas e a satisfação dos usuários.

---

## 📄 Licença

Este projeto possui finalidade **acadêmica** e está sendo desenvolvido como parte do Trabalho de Conclusão de Curso II.
