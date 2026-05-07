# Bliss Agent

AI coding agent for Bliss Applications — Electron + Vue 3 + Qwen via OpenRouter.

## Stack

- **Electron** — cross-platform desktop shell (Windows, Mac, Linux)
- **Vue 3** — UI
- **Node.js** — agentic loop + tool execution
- **Qwen / free tool-capable models** via OpenRouter

## Tools disponíveis

| Tool | Descrição |
|------|-----------|
| `read_file` | Lê um ficheiro |
| `write_file` | Escreve/cria um ficheiro |
| `list_directory` | Lista conteúdo de uma pasta |
| `run_command` | Executa comando shell (git, dotnet, npm...) |
| `create_directory` | Cria pasta recursivamente |
| `delete_file` | Apaga um ficheiro |

## Setup

### 1. Instalar dependências

```bash
npm install
```

### 2. Obter API Key (gratuito)

1. Vai a [openrouter.ai](https://openrouter.ai)
2. Cria conta
3. Vai a Keys → Create Key
4. Cola a key na app em `Settings → Provider → OpenRouter Key`
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

### 3. Correr em desenvolvimento

```bash
npm run dev
```

### 4. Build para distribuição

```bash
npm run build
```

O executável fica em `release/`.

## Estrutura do projeto

```
bliss-agent/
├── src/
│   ├── main/
│   │   ├── index.js      # Electron main process + agentic loop
│   │   └── preload.js    # Bridge segura main ↔ renderer
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── main.js
│           ├── App.vue   # UI completa
│           └── style.css
├── package.json
└── vite.config.js
```

## Como funciona o loop agêntico

```
User message
     ↓
Chama OpenRouter com lista de tools
     ↓
Modelo responde com tool_calls?
     ├── Sim → executa tool (lê ficheiro, corre comando, etc.)
     │         → devolve resultado ao modelo
     │         → repete (até 20 iterações)
     └── Não → resposta final para o utilizador
```

## Mudar o modelo

Em `src/main/index.js`, lista `MODEL_CANDIDATES`:

```js
const MODEL_CANDIDATES = [
     'qwen/qwen3-coder:free',
// alternativas:
     'qwen/qwen3-next-80b-a3b-instruct:free',
     'openrouter/free',
]
```

## Adicionar novas tools

Em `src/main/index.js`:

1. Adiciona à lista `TOOLS` (define o schema para o modelo)
2. Adiciona ao `switch` em `executeTool()` (implementa a lógica)
