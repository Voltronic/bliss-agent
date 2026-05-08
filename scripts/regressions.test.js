const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const sourcePath = path.join(__dirname, '..', 'src', 'main', 'index.js')
const sourceText = fs.readFileSync(sourcePath, 'utf-8')

function extractFunctionSource(name) {
  const signature = `function ${name}(`
  const startIndex = sourceText.indexOf(signature)
  if (startIndex === -1) {
    throw new Error(`Could not find function ${name} in src/main/index.js`)
  }

  const remainder = sourceText.slice(startIndex)
  const nextDeclarationMatch = /\n(?:async\s+)?function\s+\w+\(|\nconst\s+\w+\s*=/.exec(remainder.slice(signature.length))

  if (!nextDeclarationMatch) {
    return remainder.trim()
  }

  const endIndex = startIndex + signature.length + nextDeclarationMatch.index
  return sourceText.slice(startIndex, endIndex).trimEnd()
}

function loadFunctions(functionNames) {
  const sandbox = {
    require,
    console: { log() {}, error() {}, warn() {} },
    process,
    Buffer,
    path,
    fs,
  }

  vm.createContext(sandbox)

  const source = functionNames
    .map((name) => extractFunctionSource(name))
    .join('\n\n')

  vm.runInContext(`${source}\nthis.__extracted = { ${functionNames.join(', ')} };`, sandbox)
  return sandbox.__extracted
}

const {
  normalizeMessageContent,
  extractBalancedJsonObject,
  normalizeRequestedToolName,
  normalizeInlineToolArguments,
  extractBalancedJsonCandidate,
  normalizeInlineToolCallEntries,
  parseInlineToolCalls,
  resolveToolPath,
  toRelativeToolPath,
  createRunDiscoveryState,
  toDiscoveryKey,
  recordDiscoveredPath,
  ensureGroundedFileMutation,
} = loadFunctions([
  'normalizeMessageContent',
  'extractBalancedJsonObject',
  'normalizeRequestedToolName',
  'normalizeInlineToolArguments',
  'extractBalancedJsonCandidate',
  'normalizeInlineToolCallEntries',
  'parseInlineToolCalls',
  'resolveToolPath',
  'toRelativeToolPath',
  'createRunDiscoveryState',
  'toDiscoveryKey',
  'recordDiscoveredPath',
  'ensureGroundedFileMutation',
])

test('parseInlineToolCalls accepts raw JSON arrays of tool calls', () => {
  const raw = '[{"name":"apply_patch","arguments":{"replaceAll":false,"newText":"EventHandler object sender = null","path":"WinFormsApp/WinFormsApp/WinFormsApp.csproj","oldText":"EventHandler object sender"}}]'
  const parsed = parseInlineToolCalls(raw)

  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].function.name, 'apply_patch')

  const args = JSON.parse(parsed[0].function.arguments)
  assert.equal(args.path, 'WinFormsApp/WinFormsApp/WinFormsApp.csproj')
  assert.equal(args.oldText, 'EventHandler object sender')
})

test('validation recovery blocks mutation until the parsed failing file was read', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bliss-guard-'))
  const failingFile = path.join(tempDir, 'WinFormsApp', 'WinFormsApp', 'Form1.cs')
  const otherFile = path.join(tempDir, 'WinFormsApp', 'WinFormsApp', 'WinFormsApp.csproj')

  fs.mkdirSync(path.dirname(failingFile), { recursive: true })
  fs.writeFileSync(failingFile, 'class Form1 {}\n')
  fs.writeFileSync(otherFile, '<Project />\n')

  const runState = {
    discovery: createRunDiscoveryState(),
    pendingValidationRecovery: true,
    lastValidationFailure: {
      target: {
        path: failingFile,
        displayPath: 'WinFormsApp/WinFormsApp/Form1.cs',
        startLine: 65,
        endLine: 73,
      },
    },
  }

  recordDiscoveredPath(runState, tempDir, otherFile)
  const result = ensureGroundedFileMutation(tempDir, 'apply_patch', { path: 'WinFormsApp/WinFormsApp/WinFormsApp.csproj' }, runState)

  assert.equal(result.success, false)
  assert.match(result.error, /validation recovery is active/i)
  assert.match(result.error, /Form1\.cs/)
  assert.match(result.error, /65-73/)
})

test('validation recovery falls back to normal grounding once the failing file has been read', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bliss-guard-'))
  const failingFile = path.join(tempDir, 'WinFormsApp', 'WinFormsApp', 'Form1.cs')
  const otherFile = path.join(tempDir, 'WinFormsApp', 'WinFormsApp', 'WinFormsApp.csproj')

  fs.mkdirSync(path.dirname(failingFile), { recursive: true })
  fs.writeFileSync(failingFile, 'class Form1 {}\n')
  fs.writeFileSync(otherFile, '<Project />\n')

  const runState = {
    discovery: createRunDiscoveryState(),
    pendingValidationRecovery: true,
    lastValidationFailure: {
      target: {
        path: failingFile,
        displayPath: 'WinFormsApp/WinFormsApp/Form1.cs',
        startLine: 65,
        endLine: 73,
      },
    },
  }

  recordDiscoveredPath(runState, tempDir, otherFile)
  recordDiscoveredPath(runState, tempDir, failingFile, { wasRead: true })

  const result = ensureGroundedFileMutation(tempDir, 'apply_patch', { path: 'WinFormsApp/WinFormsApp/WinFormsApp.csproj' }, runState)
  assert.equal(result.success, false)
  assert.doesNotMatch(result.error, /validation recovery is active/i)
  assert.match(result.error, /has not been read in this run/i)
  assert.match(result.error, /WinFormsApp\.csproj/i)
})