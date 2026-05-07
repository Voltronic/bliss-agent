const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { exec, execFile, spawn, fork } = require('child_process')
const https = require('https')

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
const TOOL_WORKER_PATH = path.join(__dirname, 'tool-worker.js')
const activeAgentRuns = new Map()
const providerModelCursor = new Map()
const providerModelAvailability = new Map()

const OPENROUTER_MODEL_CANDIDATES = [
  'qwen/qwen3-coder:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'openrouter/free',
]

const GEMINI_MODEL_CANDIDATES = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
]

const IGNORED_SCAN_DIRS = new Set([
  '.git',
  '.vs',
  'bin',
  'node_modules',
  'obj',
  'dist',
  'release',
  '.vite',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'site-packages',
  'vendor',
  'build',
  'target',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
])

const APPROVAL_REQUIRED_TOOLS = {
  apply_patch: { label: 'Apply patch', riskLevel: 'high' },
  write_file: { label: 'Write file', riskLevel: 'high' },
  run_command: { label: 'Run command', riskLevel: 'high' },
  git_create_branch: { label: 'Create branch', riskLevel: 'medium' },
  git_add: { label: 'Stage files', riskLevel: 'medium' },
  git_commit: { label: 'Create commit', riskLevel: 'high' },
  github_issue_create: { label: 'Create GitHub issue', riskLevel: 'high' },
  github_issue_edit: { label: 'Edit GitHub issue', riskLevel: 'high' },
  github_issue_close: { label: 'Close GitHub issue', riskLevel: 'high' },
  github_issue_reopen: { label: 'Reopen GitHub issue', riskLevel: 'high' },
  github_issue_comment: { label: 'Comment on GitHub issue', riskLevel: 'high' },
  github_pr_edit: { label: 'Edit GitHub PR', riskLevel: 'high' },
  github_pr_review_submit: { label: 'Submit GitHub PR review', riskLevel: 'high' },
  github_pr_close: { label: 'Close GitHub PR', riskLevel: 'high' },
  github_pr_reopen: { label: 'Reopen GitHub PR', riskLevel: 'high' },
  github_pr_comment: { label: 'Comment on GitHub PR', riskLevel: 'high' },
  github_pr_merge: { label: 'Merge GitHub PR', riskLevel: 'high' },
  github_pr_create: { label: 'Create draft PR', riskLevel: 'high' },
  create_directory: { label: 'Create directory', riskLevel: 'medium' },
  delete_file: { label: 'Delete file', riskLevel: 'high' },
}

function logMain(...args) {
  console.log('[bliss-agent]', ...args)
}

function createAgentCancellationError() {
  const error = new Error('Agent run cancelled')
  error.code = 'AGENT_CANCELLED'
  return error
}

function isAgentCancellationError(error) {
  return error?.code === 'AGENT_CANCELLED'
}

function getAgentRunKey(senderId, runId) {
  return `${senderId}:${runId}`
}

function getProviderCursorKey(senderId, provider) {
  return `${senderId}:${provider}`
}

function resetProviderModelCursor(cursorKey) {
  providerModelCursor.set(cursorKey, 0)
}

function getProviderModelCursor(cursorKey, candidatesLength) {
  if (!candidatesLength) return 0
  const currentValue = Number(providerModelCursor.get(cursorKey) || 0)
  return ((currentValue % candidatesLength) + candidatesLength) % candidatesLength
}

function setProviderModelCursor(cursorKey, nextIndex, candidatesLength) {
  if (!candidatesLength) return
  providerModelCursor.set(cursorKey, ((nextIndex % candidatesLength) + candidatesLength) % candidatesLength)
}

function rotateCandidateModels(candidates, startIndex) {
  if (!Array.isArray(candidates) || !candidates.length) return []
  if (!startIndex) return candidates.map((model, index) => ({ model, index }))

  const rotated = []
  for (let offset = 0; offset < candidates.length; offset++) {
    const index = (startIndex + offset) % candidates.length
    rotated.push({ model: candidates[index], index })
  }
  return rotated
}

function getProviderModelAvailabilityKey(provider, model) {
  return `${provider}:${model}`
}

function getProviderModelAvailability(provider, model) {
  return providerModelAvailability.get(getProviderModelAvailabilityKey(provider, model)) || null
}

function blockProviderModel(provider, model, details = {}) {
  providerModelAvailability.set(getProviderModelAvailabilityKey(provider, model), {
    blocked: true,
    blockedAt: Date.now(),
    ...details,
  })
}

function cancelAgentRunState(runState) {
  if (!runState || runState.cancelled) return

  runState.cancelled = true

  if (runState.pendingApproval?.resolve) {
    runState.pendingApproval.resolve({ approved: false, cancelled: true, requestId: runState.pendingApproval.requestId })
    runState.pendingApproval = null
  }

  if (runState.activeRequest) {
    runState.activeRequest.destroy(createAgentCancellationError())
    runState.activeRequest = null
  }

  if (runState.activeWorker && !runState.activeWorker.killed) {
    runState.activeWorker.kill()
    runState.activeWorker = null
  }

  if (runState.activeSubprocess && !runState.activeSubprocess.killed) {
    runState.activeSubprocess.kill()
    runState.activeSubprocess = null
  }
}

function cancelActiveToolExecution(runState) {
  if (!runState?.activeToolName) return false

  runState.toolCancellation = {
    requested: true,
    toolName: runState.activeToolName,
  }

  if (runState.activeWorker && !runState.activeWorker.killed) {
    runState.activeWorker.kill()
    runState.activeWorker = null
  }

  if (runState.activeSubprocess && !runState.activeSubprocess.killed) {
    runState.activeSubprocess.kill()
    runState.activeSubprocess = null
  }

  return true
}

function clearActiveToolExecution(runState, toolName = '') {
  if (!runState) return

  if (!toolName || runState.activeToolName === toolName) {
    runState.activeToolName = ''
  }

  if (!toolName || runState.toolCancellation?.toolName === toolName) {
    runState.toolCancellation = {
      requested: false,
      toolName: '',
    }
  }
}

function ensureRunNotCancelled(runState) {
  if (runState?.cancelled) {
    throw createAgentCancellationError()
  }
}

function createCancelledToolResult(options = {}) {
  const toolCancelled = Boolean(options.toolCancelled)
  const toolName = options.toolName || 'Tool'
  return {
    success: false,
    cancelled: true,
    toolCancelled,
    error: toolCancelled ? `${toolName} was cancelled` : 'Agent run cancelled',
    message: toolCancelled ? `${toolName} was cancelled before completion.` : 'Agent run cancelled',
  }
}

function createRunDiscoveryState() {
  return {
    hasContext: false,
    discoveredPaths: new Set(),
    listedDirectories: new Set(),
    readFiles: new Set(),
  }
}

function toDiscoveryKey(baseDir, targetPath) {
  return toRelativeToolPath(baseDir, targetPath).replace(/\\/g, '/').toLowerCase()
}

function recordDiscoveredPath(runState, baseDir, targetPath, options = {}) {
  if (!runState?.discovery || !targetPath) return

  const key = toDiscoveryKey(baseDir, targetPath)
  runState.discovery.hasContext = true
  runState.discovery.discoveredPaths.add(key)

  if (options.isDirectory) {
    runState.discovery.listedDirectories.add(key)
  }

  if (options.wasRead) {
    runState.discovery.readFiles.add(key)
  }
}

function recordToolDiscovery(runState, baseDir, toolName, toolArgs, result) {
  if (!runState?.discovery || !result?.success) return

  if (toolName === 'list_directory') {
    const directoryPath = resolveToolPath(baseDir, toolArgs.path || '.')
    recordDiscoveredPath(runState, baseDir, directoryPath, { isDirectory: true })

    for (const entry of result.entries || []) {
      recordDiscoveredPath(runState, baseDir, path.join(directoryPath, entry.name), {
        isDirectory: entry.type === 'dir',
      })
    }
    return
  }

  if (toolName === 'find_files') {
    for (const filePath of result.files || []) {
      recordDiscoveredPath(runState, baseDir, resolveToolPath(baseDir, filePath))
    }
    return
  }

  if (toolName === 'search_text') {
    for (const match of result.matches || []) {
      recordDiscoveredPath(runState, baseDir, resolveToolPath(baseDir, match.path))
    }
    return
  }

  if (toolName === 'read_file' || toolName === 'read_file_range') {
    recordDiscoveredPath(runState, baseDir, resolveToolPath(baseDir, toolArgs.path), { wasRead: true })
  }
}

function ensureGroundedFileMutation(baseDir, toolName, toolArgs, runState) {
  if (!runState?.discovery) return null
  if (!['apply_patch', 'write_file', 'delete_file', 'create_directory'].includes(toolName)) return null

  if (!runState.discovery.hasContext) {
    return {
      success: false,
      grounded: false,
      error: `Before using ${toolName}, inspect the relevant workspace area with list_directory, find_files, search_text, read_file, or read_file_range.`,
    }
  }

  const targetPath = toolArgs?.path
  if (!targetPath) return null

  const absoluteTargetPath = resolveToolPath(baseDir, targetPath)
  const targetKey = toDiscoveryKey(baseDir, absoluteTargetPath)
  const parentKey = toDiscoveryKey(baseDir, path.dirname(absoluteTargetPath))
  const targetExists = fs.existsSync(absoluteTargetPath)
  const targetWasDiscovered = runState.discovery.discoveredPaths.has(targetKey)
  const targetWasRead = runState.discovery.readFiles.has(targetKey)
  const parentWasDiscovered = runState.discovery.listedDirectories.has(parentKey) || runState.discovery.discoveredPaths.has(parentKey)

  if (targetExists) {
    if (toolName === 'apply_patch' && !targetWasRead) {
      return {
        success: false,
        grounded: false,
        error: `${toolName} was blocked because ${toRelativeToolPath(baseDir, absoluteTargetPath)} has not been read in this run. Read the concrete file first before patching it.`,
      }
    }

    if (targetWasDiscovered) return null

    return {
      success: false,
      grounded: false,
      error: `${toolName} was blocked because ${toRelativeToolPath(baseDir, absoluteTargetPath)} has not been discovered in this run. Inspect the concrete file first instead of assuming its name.`,
    }
  }

  if (parentWasDiscovered) return null

  return {
    success: false,
    grounded: false,
    error: `${toolName} was blocked because the parent location for ${toRelativeToolPath(baseDir, absoluteTargetPath)} has not been inspected in this run. Discover the relevant directory first.`,
  }
}

function attachActiveSubprocess(runState, child) {
  if (!runState || !child) return
  runState.activeSubprocess = child

  if (runState.cancelled && !child.killed) {
    child.kill()
  }
}

function clearActiveSubprocess(runState, child) {
  if (runState?.activeSubprocess === child) {
    runState.activeSubprocess = null
  }
}

function getProcessCancellationScope(runState, error) {
  if (runState?.cancelled) return 'run'
  if (runState?.toolCancellation?.requested && (error?.killed || error?.signal === 'SIGTERM')) return 'tool'
  return null
}

function runExecFileCommand(command, args, options, runState, mapResult) {
  return new Promise((resolve) => {
    if (runState?.cancelled) {
      resolve(createCancelledToolResult())
      return
    }

    const child = execFile(command, args, options, (error, stdout, stderr) => {
      clearActiveSubprocess(runState, child)

      const cancellationScope = getProcessCancellationScope(runState, error)
      if (cancellationScope) {
        resolve(createCancelledToolResult({
          toolCancelled: cancellationScope === 'tool',
          toolName: runState?.activeToolName || runState?.toolCancellation?.toolName || command,
        }))
        return
      }

      resolve(mapResult(error, stdout, stderr))
    })

    attachActiveSubprocess(runState, child)
  })
}

function runExecCommand(command, options, runState, mapResult) {
  return new Promise((resolve) => {
    if (runState?.cancelled) {
      resolve(createCancelledToolResult())
      return
    }

    const child = exec(command, options, (error, stdout, stderr) => {
      clearActiveSubprocess(runState, child)

      const cancellationScope = getProcessCancellationScope(runState, error)
      if (cancellationScope) {
        resolve(createCancelledToolResult({
          toolCancelled: cancellationScope === 'tool',
          toolName: runState?.activeToolName || runState?.toolCancellation?.toolName || 'Command',
        }))
        return
      }

      resolve(mapResult(error, stdout, stderr))
    })

    attachActiveSubprocess(runState, child)
  })
}

function toIpcSafe(value) {
  return JSON.parse(JSON.stringify(value, (_, currentValue) => {
    if (currentValue instanceof Error) {
      return {
        name: currentValue.name,
        message: currentValue.message,
        stack: currentValue.stack,
      }
    }

    if (typeof currentValue === 'bigint') {
      return currentValue.toString()
    }

    if (typeof currentValue === 'function' || typeof currentValue === 'symbol' || typeof currentValue === 'undefined') {
      return null
    }

    return currentValue
  }))
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part.text === 'string') return part.text
        if (part && typeof part.content === 'string') return part.content
        return ''
      })
      .join('\n')
      .trim()
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text.trim()
    if (typeof content.content === 'string') return content.content.trim()
  }
  return ''
}

function extractBalancedJsonObject(text, startIndex) {
  let depth = 0
  let inString = false
  let isEscaped = false

  for (let index = startIndex; index < text.length; index++) {
    const character = text[index]

    if (inString) {
      if (isEscaped) {
        isEscaped = false
        continue
      }

      if (character === '\\') {
        isEscaped = true
        continue
      }

      if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
      continue
    }

    if (character === '{') {
      depth++
      continue
    }

    if (character === '}') {
      depth--
      if (depth === 0) {
        return text.slice(startIndex, index + 1)
      }
    }
  }

  return ''
}

function normalizeInlineToolArguments(value) {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return { input: value }
    }
  }
  if (typeof value === 'object') return value
  return {}
}

function getDisplaySafeAssistantContent(content) {
  const text = normalizeMessageContent(content)
  if (!text) return ''

  const markerMatch = /(TOOLCALL|TOOL_CALL|FUNCTIONCALL|FUNCTION_CALL|CALL)\s*>?/i.exec(text)
  if (!markerMatch || typeof markerMatch.index !== 'number') return text

  return text.slice(0, markerMatch.index).trimEnd()
}

function createEmptyStreamedAssistantMessage() {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [],
  }
}

function mergeStreamedToolCalls(targetToolCalls, toolCallDeltas) {
  if (!Array.isArray(toolCallDeltas)) return

  for (const toolCallDelta of toolCallDeltas) {
    const targetIndex = Number.isInteger(toolCallDelta?.index) ? toolCallDelta.index : targetToolCalls.length

    if (!targetToolCalls[targetIndex]) {
      targetToolCalls[targetIndex] = {
        id: toolCallDelta?.id || `stream-tool-${targetIndex + 1}`,
        type: toolCallDelta?.type || 'function',
        function: {
          name: '',
          arguments: '',
        },
      }
    }

    const target = targetToolCalls[targetIndex]
    if (toolCallDelta?.id) target.id = toolCallDelta.id
    if (toolCallDelta?.type) target.type = toolCallDelta.type

    if (toolCallDelta?.function?.name) {
      target.function.name += toolCallDelta.function.name
    }

    if (toolCallDelta?.function?.arguments) {
      target.function.arguments += toolCallDelta.function.arguments
    }
  }
}

function finalizeStreamedAssistantMessage(message) {
  const toolCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls
        .filter(Boolean)
        .map((toolCall, index) => ({
          id: toolCall.id || `stream-tool-${index + 1}`,
          type: toolCall.type || 'function',
          function: {
            name: toolCall.function?.name || '',
            arguments: toolCall.function?.arguments || '',
          },
        }))
    : []

  return toolCalls.length
    ? {
        role: message?.role || 'assistant',
        content: message?.content || '',
        tool_calls: toolCalls,
      }
    : {
        role: message?.role || 'assistant',
        content: message?.content || '',
      }
}

function buildCancelledAgentResult(messages, runState) {
  const partialReply = normalizeMessageContent(runState?.partialAssistantText || '')
  if (partialReply) {
    return toIpcSafe({
      success: false,
      cancelled: true,
      error: 'Agent run cancelled',
      partialReply,
      messages: [...messages.slice(1), { role: 'assistant', content: partialReply }],
    })
  }

  return toIpcSafe({ success: false, cancelled: true, error: 'Agent run cancelled' })
}

function formatProviderErrorMessage({ providerName, model, statusCode, parsedError, rawBody }) {
  const rawMessage = parsedError?.message || parsedError?.error?.message || ''
  const normalizedProvider = providerName === 'generativelanguage.googleapis.com' ? 'gemini' : 'openrouter'

  if (normalizedProvider === 'gemini' && statusCode === 429) {
    const detailsText = typeof rawMessage === 'string' && rawMessage.trim()
      ? rawMessage.trim()
      : 'Google AI Studio rejected the request with HTTP 429.'

    return `${detailsText} Check the AI Studio rate limits and billing for the project behind this API key, or switch to a lower-cost model/provider.`
  }

  if (typeof rawMessage === 'string' && rawMessage.trim()) {
    return rawMessage.trim()
  }

  if (normalizedProvider === 'gemini' && statusCode === 429) {
    return `Gemini API request was rate-limited or quota-exhausted for model ${model}. Check AI Studio rate limits and billing for this project.`
  }

  const rawSnippet = typeof rawBody === 'string' ? rawBody.trim().slice(0, 240) : ''
  return rawSnippet
    ? `Provider request failed with status ${statusCode}: ${rawSnippet}`
    : `Provider request failed with status ${statusCode}`
}

function createFallbackExhaustedError(providerLabel, failedAttempts, fallbackLabel) {
  const attempts = Array.isArray(failedAttempts) ? failedAttempts.filter(Boolean) : []
  const lastAttempt = attempts[attempts.length - 1] || null
  const attemptSummary = attempts.length
    ? attempts
        .map((attempt) => `${attempt.model}${attempt.statusCode ? ` (${attempt.statusCode})` : ''}`)
        .join(', ')
    : 'no attempted models recorded'

  const lastMessage = lastAttempt?.message || 'Unknown provider error'
  const error = new Error(`${providerLabel} fallback exhausted after ${attempts.length || 0} attempt${attempts.length === 1 ? '' : 's'} via ${fallbackLabel}: ${attemptSummary}. Last error: ${lastMessage}`)
  error.statusCode = lastAttempt?.statusCode || 0
  error.model = lastAttempt?.model || ''
  error.details = { attempts }
  return error
}

function createProviderQuotaExhaustedError(providerLabel, failedAttempts, message) {
  const attempts = Array.isArray(failedAttempts) ? failedAttempts.filter(Boolean) : []
  const attemptSummary = attempts.length
    ? attempts
        .map((attempt) => `${attempt.model}${attempt.statusCode ? ` (${attempt.statusCode})` : ''}`)
        .join(', ')
    : 'no attempted models recorded'

  const error = new Error(`${providerLabel} free-tier fallback is unavailable for this account right now: ${message}. Attempts: ${attemptSummary}`)
  error.statusCode = 429
  error.details = { attempts, providerQuotaExhausted: true }
  return error
}

function classifyOpenRouterFallbackError(error) {
  const message = error?.message || ''
  const statusCode = Number(error?.statusCode || 0)
  const providerQuotaExhausted = statusCode === 429
    && /free-models-per-day|free model requests per day|add 10 credits|rate limit exceeded:\s*free/i.test(message)

  const permanentlyUnavailable = statusCode === 404
    || /model not found|not a valid model|invalid model/i.test(message)

  const retryable = providerQuotaExhausted
    || /No endpoints found|model not found|not a valid model|provider returned error|temporarily unavailable|rate limit/i.test(message)
    || [429, 500, 502, 503, 504].includes(statusCode)

  return {
    message,
    statusCode,
    retryable,
    permanentlyUnavailable,
    providerQuotaExhausted,
  }
}

function parseInlineToolCalls(content) {
  const text = normalizeMessageContent(content)
  if (!text) return []

  const markerPattern = /(TOOLCALL|TOOL_CALL|FUNCTIONCALL|FUNCTION_CALL|CALL)\s*>?/gi
  if (!markerPattern.test(text)) return []

  const toolCalls = []
  markerPattern.lastIndex = 0

  while (true) {
    const markerMatch = markerPattern.exec(text)
    if (!markerMatch) break

    const markerIndex = markerMatch.index

    const jsonStart = text.indexOf('{', markerIndex)
    if (jsonStart === -1) break

    const rawJson = extractBalancedJsonObject(text, jsonStart)
    if (!rawJson) break

    try {
      const parsed = JSON.parse(rawJson)
      const toolName = parsed.name || parsed.tool || parsed.function?.name
      const rawArguments = parsed.arguments ?? parsed.args ?? parsed.function?.arguments ?? {}

      if (toolName) {
        toolCalls.push({
          id: `inline-tool-${toolCalls.length + 1}`,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify(normalizeInlineToolArguments(rawArguments)),
          }
        })
      }
    } catch (error) {
      logMain('Failed to parse inline TOOLCALL payload', error.message)
    }

    markerPattern.lastIndex = jsonStart + rawJson.length
  }

  return toolCalls
}

function normalizeAssistantMessage(message) {
  if (!message || typeof message !== 'object') return message
  if (message.tool_calls?.length) return message

  const inlineToolCalls = parseInlineToolCalls(message.content)
  if (!inlineToolCalls.length) return message

  return {
    ...message,
    content: '',
    tool_calls: inlineToolCalls,
  }
}

function summarizeToolResult(toolName, result) {
  if (!result) return `${toolName}: no result`
  if (!result.success) return `${toolName} failed: ${result.error}`
  if (toolName === 'read_file') {
    const filePath = result.path || 'the file'
    return `${filePath} is available in the inspector via the button above.`
  }
  if (toolName === 'read_file_range') {
    const filePath = result.path || 'the file'
    const startLine = result.startLine || 1
    const endLine = result.endLine || startLine
    return `${filePath} lines ${startLine}-${endLine} are available in the inspector via the button above.`
  }
  if (Array.isArray(result.matches)) {
    const preview = result.matches
      .slice(0, 20)
      .map((match) => `${match.path}:${match.lineNumber} ${match.line}`)
      .join('\n')
    return `${toolName} completed:\n${preview}`
  }
  if (Array.isArray(result.files)) {
    if (!result.files.length && Array.isArray(result.ignoredDirectories) && result.ignoredDirectories.length) {
      return `${toolName} completed: no files were found outside ignored directories (${result.ignoredDirectories.join(', ')}).`
    }

    const preview = result.files.slice(0, 50).join('\n')
    return `${toolName} completed:\n${preview}`
  }
  if (Array.isArray(result.entries)) {
    const preview = result.entries
      .slice(0, 20)
      .map((entry) => `${entry.type === 'dir' ? '[dir]' : '[file]'} ${entry.name}`)
      .join('\n')
    return `${toolName} completed:\n${preview}`
  }
  if (typeof result.content === 'string' && result.content.trim()) return `${toolName} completed:\n${result.content.trim()}`
  if (typeof result.stdout === 'string' && result.stdout.trim()) return `${toolName} completed:\n${result.stdout.trim()}`
  if (typeof result.stderr === 'string' && result.stderr.trim()) return `${toolName} completed:\n${result.stderr.trim()}`
  if (typeof result.message === 'string' && result.message.trim()) return `${toolName} completed: ${result.message.trim()}`
  return `${toolName} completed successfully`
}

function buildToolResultForModel(toolName, toolArgs, result) {
  if (toolName === 'read_file') {
    const content = typeof result?.content === 'string' ? result.content : ''
    return JSON.stringify({
      success: Boolean(result?.success),
      path: toolArgs?.path || result?.path || '',
      totalLines: content ? content.split(/\r?\n/).length : 0,
      contentOmitted: true,
      note: 'State only that the content is available via the inspector button in the tool result. Do not claim it was already opened. Do not mention privacy, security, policy, or data protection reasons. Do not reproduce the raw file contents in chat. Summarize briefly or ask whether the user wants a specific section.',
    })
  }

  if (toolName === 'read_file_range') {
    const content = typeof result?.content === 'string' ? result.content : ''
    return JSON.stringify({
      success: Boolean(result?.success),
      path: toolArgs?.path || result?.path || '',
      startLine: result?.startLine || toolArgs?.startLine || 1,
      endLine: result?.endLine || toolArgs?.endLine || 1,
      linesReturned: content ? content.split(/\r?\n/).length : 0,
      contentOmitted: true,
      note: 'State only that the content is available via the inspector button in the tool result. Do not claim it was already opened. Do not mention privacy, security, policy, or data protection reasons. Do not reproduce the raw file contents in chat. Summarize briefly or ask whether the user wants another range.',
    })
  }

  return JSON.stringify(result)
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173')
  } else {
    win.loadFile(path.join(__dirname, '../../dist/index.html'))
  }
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })

// ─── Tools ────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find files by partial path or filename match inside the working directory',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Partial path or filename to match. Leave empty to list files.' },
          path: { type: 'string', description: 'Root folder to search inside, relative to the working directory' },
          maxResults: { type: 'number', description: 'Maximum number of results to return' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_text',
      description: 'Search text content in files inside the working directory',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or regex pattern to search for' },
          path: { type: 'string', description: 'Root folder or file to search inside' },
          isRegex: { type: 'boolean', description: 'Whether query should be treated as a regular expression' },
          caseSensitive: { type: 'boolean', description: 'Whether the search should be case-sensitive' },
          maxResults: { type: 'number', description: 'Maximum number of matches to return' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file_range',
      description: 'Read only a line range from a text file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative path to the file' },
          startLine: { type: 'number', description: '1-based starting line number' },
          endLine: { type: 'number', description: '1-based ending line number' }
        },
        required: ['path', 'startLine', 'endLine']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Apply an exact-text patch to a file by replacing a known snippet with a new snippet',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to patch' },
          oldText: { type: 'string', description: 'Exact existing text to replace' },
          newText: { type: 'string', description: 'Replacement text' },
          replaceAll: { type: 'boolean', description: 'Replace all matches instead of a single exact match' }
        },
        required: ['path', 'oldText', 'newText']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or overwrite content to a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
          content: { type: 'string', description: 'Content to write' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and folders in a directory',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show git status for the working directory',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show git diff for the working directory or a specific file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional file path to diff' },
          staged: { type: 'boolean', description: 'Whether to show staged changes' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_build',
      description: 'Run the project build for the selected working directory',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional subdirectory inside the working directory' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_test',
      description: 'Run the project tests for the selected working directory',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional subdirectory inside the working directory' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_lint',
      description: 'Run the project linter for the selected working directory',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional subdirectory inside the working directory' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_create_branch',
      description: 'Create and switch to a new git branch in the working directory',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'New branch name' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_add',
      description: 'Stage files in git for the working directory',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional file or folder to stage' },
          all: { type: 'boolean', description: 'Stage all modified files' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description: 'Create a git commit in the working directory',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message' }
        },
        required: ['message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_auth_status',
      description: 'Check GitHub CLI authentication and repository remote readiness for the selected working directory',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_repo_info',
      description: 'Read GitHub repository context for the selected working directory using the GitHub CLI',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_issue_view',
      description: 'Read a GitHub issue by number from the repository associated with the selected working directory',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Issue number to inspect' }
        },
        required: ['number']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_issue_create',
      description: 'Create a GitHub issue in the repository associated with the selected working directory using the GitHub CLI',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Issue title' },
          body: { type: 'string', description: 'Issue body/description' },
          labels: { type: 'string', description: 'Optional comma-separated labels to apply' },
          assignees: { type: 'string', description: 'Optional comma-separated assignees to add' }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_issue_edit',
      description: 'Edit a GitHub issue in the repository associated with the selected working directory using the GitHub CLI',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Issue number to edit' },
          title: { type: 'string', description: 'Optional replacement issue title' },
          body: { type: 'string', description: 'Optional replacement issue body' },
          addLabels: { type: 'string', description: 'Optional comma-separated labels to add' },
          removeLabels: { type: 'string', description: 'Optional comma-separated labels to remove' },
          addAssignees: { type: 'string', description: 'Optional comma-separated assignees to add' },
          removeAssignees: { type: 'string', description: 'Optional comma-separated assignees to remove' }
        },
        required: ['number']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_issue_close',
      description: 'Close a GitHub issue in the repository associated with the selected working directory using the GitHub CLI',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Issue number to close' },
          comment: { type: 'string', description: 'Optional closing comment' },
          reason: { type: 'string', description: 'Optional closing reason: completed or not planned' }
        },
        required: ['number']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_issue_reopen',
      description: 'Reopen a GitHub issue in the repository associated with the selected working directory using the GitHub CLI',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Issue number to reopen' },
          comment: { type: 'string', description: 'Optional reopening comment' }
        },
        required: ['number']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_issue_comment',
      description: 'Add a comment to a GitHub issue in the repository associated with the selected working directory using the GitHub CLI',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Issue number to comment on' },
          body: { type: 'string', description: 'Comment body' }
        },
        required: ['number', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_pr_view',
      description: 'Read a GitHub pull request by number from the repository associated with the selected working directory',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Pull request number to inspect' }
        },
        required: ['number']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_pr_review_comments',
      description: 'Read review comments for a GitHub pull request from the repository associated with the selected working directory',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Pull request number to inspect' }
        },
        required: ['number']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_pr_edit',
      description: 'Edit a GitHub pull request in the repository associated with the selected working directory using the GitHub CLI',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Pull request number to edit' },
          title: { type: 'string', description: 'Optional replacement PR title' },
          body: { type: 'string', description: 'Optional replacement PR body' },
          base: { type: 'string', description: 'Optional replacement base branch' },
          addLabels: { type: 'string', description: 'Optional comma-separated labels to add' },
          removeLabels: { type: 'string', description: 'Optional comma-separated labels to remove' },
          addAssignees: { type: 'string', description: 'Optional comma-separated assignees to add' },
          removeAssignees: { type: 'string', description: 'Optional comma-separated assignees to remove' }
        },
        required: ['number']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_pr_review_submit',
      description: 'Submit a GitHub pull request review in the repository associated with the selected working directory using the GitHub CLI',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Pull request number to review' },
          event: { type: 'string', description: 'Review event: comment, approve, or request_changes' },
          body: { type: 'string', description: 'Optional review body. Required for comment reviews.' }
        },
        required: ['number', 'event']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_pr_close',
      description: 'Close a GitHub pull request in the repository associated with the selected working directory using the GitHub CLI',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Pull request number to close' },
          comment: { type: 'string', description: 'Optional closing comment' },
          deleteBranch: { type: 'boolean', description: 'Delete the branch after closing when supported' }
        },
        required: ['number']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_pr_reopen',
      description: 'Reopen a GitHub pull request in the repository associated with the selected working directory using the GitHub CLI',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Pull request number to reopen' },
          comment: { type: 'string', description: 'Optional reopening comment' }
        },
        required: ['number']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_pr_comment',
      description: 'Add a comment to a GitHub pull request in the repository associated with the selected working directory using the GitHub CLI',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Pull request number to comment on' },
          body: { type: 'string', description: 'Comment body' }
        },
        required: ['number', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_pr_merge',
      description: 'Merge a GitHub pull request in the repository associated with the selected working directory using the GitHub CLI',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Pull request number to merge' },
          method: { type: 'string', description: 'Merge method: merge, squash, or rebase' },
          subject: { type: 'string', description: 'Optional custom merge commit subject' },
          body: { type: 'string', description: 'Optional custom merge commit body' },
          deleteBranch: { type: 'boolean', description: 'Delete the branch after merge' },
          auto: { type: 'boolean', description: 'Enable auto-merge when checks complete' },
          admin: { type: 'boolean', description: 'Use admin privileges to merge when permitted' }
        },
        required: ['number']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_pr_create',
      description: 'Create a GitHub pull request from the selected working directory using the GitHub CLI',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Pull request title' },
          body: { type: 'string', description: 'Pull request description/body' },
          summary: { type: 'string', description: 'Optional short summary used to build the PR body when body is omitted' },
          validation: { type: 'string', description: 'Optional validation notes to include in the PR body when body is omitted' },
          base: { type: 'string', description: 'Optional base branch name' },
          head: { type: 'string', description: 'Optional head branch name' },
          draft: { type: 'boolean', description: 'Create as a draft pull request' }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command (git, dotnet, npm, etc.). Avoid this for standard build, test, or lint flows when run_build, run_test, or run_lint fit.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to execute' },
          cwd: { type: 'string', description: 'Working directory (optional)' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_directory',
      description: 'Create a directory (including nested)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to create' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to delete' }
        },
        required: ['path']
      }
    }
  }
]

// ─── Tool Executor ────────────────────────────────────────────────────────────

function resolveToolPath(baseDir, targetPath = '.') {
  if (!targetPath) return baseDir
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(baseDir, targetPath)
}

function toRelativeToolPath(baseDir, targetPath) {
  const relativePath = path.relative(baseDir, targetPath)
  return relativePath || '.'
}

function truncatePreview(value, maxLength = 160) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

function describeApprovalRequest(baseDir, toolName, toolArgs) {
  switch (toolName) {
    case 'apply_patch':
      return `Edit ${toRelativeToolPath(baseDir, resolveToolPath(baseDir, toolArgs.path || '.'))}`
    case 'write_file':
      return `Write ${toRelativeToolPath(baseDir, resolveToolPath(baseDir, toolArgs.path || '.'))}`
    case 'run_command':
      return `Run command: ${truncatePreview(toolArgs.command || '', 180) || 'No command provided'}`
    case 'git_create_branch':
      return `Create and switch to branch ${toolArgs.name || '(missing name)'}`
    case 'git_add':
      if (toolArgs.all) return 'Stage all modified files'
      return `Stage ${toolArgs.path || 'default git add target'}`
    case 'git_commit':
      return `Create commit: ${truncatePreview(toolArgs.message || '', 180) || 'No commit message provided'}`
    case 'github_issue_create':
      return `Create GitHub issue: ${truncatePreview(toolArgs.title || '', 180) || 'No issue title provided'}`
    case 'github_issue_edit':
      return `Edit issue #${toolArgs.number || '?'}${toolArgs.title ? `: ${truncatePreview(toolArgs.title, 180)}` : ''}`
    case 'github_issue_close':
      return `Close issue #${toolArgs.number || '?'}${toolArgs.reason ? ` as ${toolArgs.reason}` : ''}`
    case 'github_issue_reopen':
      return `Reopen issue #${toolArgs.number || '?'}`
    case 'github_issue_comment':
      return `Comment on issue #${toolArgs.number || '?'}: ${truncatePreview(toolArgs.body || '', 180) || 'No comment body provided'}`
    case 'github_pr_edit':
      return `Edit PR #${toolArgs.number || '?'}${toolArgs.title ? `: ${truncatePreview(toolArgs.title, 180)}` : ''}`
    case 'github_pr_review_submit':
      return `Submit ${toolArgs.event || 'comment'} review on PR #${toolArgs.number || '?'}`
    case 'github_pr_close':
      return `Close PR #${toolArgs.number || '?'}${toolArgs.deleteBranch ? ' and delete branch' : ''}`
    case 'github_pr_reopen':
      return `Reopen PR #${toolArgs.number || '?'}`
    case 'github_pr_comment':
      return `Comment on PR #${toolArgs.number || '?'}: ${truncatePreview(toolArgs.body || '', 180) || 'No comment body provided'}`
    case 'github_pr_merge':
      return `Merge PR #${toolArgs.number || '?'} using ${toolArgs.method || 'merge'}`
    case 'github_pr_create':
      return `Create draft PR: ${truncatePreview(toolArgs.title || '', 180) || 'No PR title provided'}`
    case 'create_directory':
      return `Create directory ${toRelativeToolPath(baseDir, resolveToolPath(baseDir, toolArgs.path || '.'))}`
    case 'delete_file':
      return `Delete ${toRelativeToolPath(baseDir, resolveToolPath(baseDir, toolArgs.path || '.'))}`
    default:
      return toolName
  }
}

async function requestToolApproval(runState, sendUpdate, baseDir, toolName, toolArgs) {
  const approvalConfig = APPROVAL_REQUIRED_TOOLS[toolName]
  if (!approvalConfig) {
    return { approved: true, cancelled: false, requestId: null }
  }

  ensureRunNotCancelled(runState)

  const requestId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const summary = describeApprovalRequest(baseDir, toolName, toolArgs)

  return new Promise((resolve) => {
    runState.pendingApproval = { requestId, resolve }
    sendUpdate({
      type: 'approval_required',
      requestId,
      tool: toolName,
      args: toolArgs,
      title: approvalConfig.label,
      riskLevel: approvalConfig.riskLevel,
      summary,
    })
  })
}

function shouldSkipWalkEntry(entryName) {
  return IGNORED_SCAN_DIRS.has(entryName)
}

async function listIgnoredDirectoriesAsync(rootPath) {
  try {
    const entries = await fs.promises.readdir(rootPath, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && shouldSkipWalkEntry(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve))
}

function walkFiles(rootPath, maxResults = 2000) {
  const results = []
  const pending = [rootPath]

  while (pending.length > 0 && results.length < maxResults) {
    const currentPath = pending.pop()
    const stats = fs.statSync(currentPath)

    if (stats.isFile()) {
      results.push(currentPath)
      continue
    }

    const entries = fs.readdirSync(currentPath, { withFileTypes: true })
    for (const entry of entries) {
      if (shouldSkipWalkEntry(entry.name)) continue
      pending.push(path.join(currentPath, entry.name))
    }
  }

  return results
}

async function walkFilesAsync(rootPath, maxResults = 2000) {
  const results = []
  const pending = [rootPath]
  let steps = 0

  while (pending.length > 0 && results.length < maxResults) {
    const currentPath = pending.pop()
    let stats

    try {
      stats = await fs.promises.stat(currentPath)
    } catch {
      continue
    }

    if (stats.isFile()) {
      results.push(currentPath)
    } else {
      let entries = []
      try {
        entries = await fs.promises.readdir(currentPath, { withFileTypes: true })
      } catch {
        entries = []
      }

      for (const entry of entries) {
        if (shouldSkipWalkEntry(entry.name)) continue
        pending.push(path.join(currentPath, entry.name))
      }
    }

    steps += 1
    if (steps % 50 === 0) {
      await yieldToEventLoop()
    }
  }

  return results
}

function isLikelyTextFile(filePath) {
  const stats = fs.statSync(filePath)
  if (stats.size > 1024 * 1024 * 2) return false

  const buffer = fs.readFileSync(filePath)
  const sample = buffer.subarray(0, Math.min(buffer.length, 512))
  return !sample.includes(0)
}

async function isLikelyTextFileAsync(filePath) {
  let stats
  try {
    stats = await fs.promises.stat(filePath)
  } catch {
    return false
  }

  if (stats.size > 1024 * 1024 * 2) return false

  try {
    const buffer = await fs.promises.readFile(filePath)
    const sample = buffer.subarray(0, Math.min(buffer.length, 512))
    return !sample.includes(0)
  } catch {
    return false
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function readFilePreview(baseDir, targetPath, focusLine) {
  const filePath = resolveToolPath(baseDir, targetPath)
  const content = await fs.promises.readFile(filePath, 'utf-8')
  const lines = content.split(/\r?\n/)
  const lineNumber = Number(focusLine || 0)

  if (lineNumber > 0) {
    const startLine = Math.max(1, lineNumber - 20)
    const endLine = Math.min(lines.length, lineNumber + 20)
    return {
      success: true,
      path: toRelativeToolPath(baseDir, filePath),
      content: lines.slice(startLine - 1, endLine).join('\n'),
      startLine,
      endLine,
      focusLine: lineNumber,
      totalLines: lines.length,
    }
  }

  return {
    success: true,
    path: toRelativeToolPath(baseDir, filePath),
    content: lines.slice(0, 400).join('\n'),
    startLine: 1,
    endLine: Math.min(lines.length, 400),
    focusLine: null,
    totalLines: lines.length,
  }
}

function runHeavyToolInChildProcess(toolName, baseDir, args, onProgress, runState) {
  return new Promise((resolve) => {
    if (runState?.cancelled) {
      resolve({ success: false, error: 'Agent run cancelled', cancelled: true, workerFailure: true })
      return
    }

    const child = fork(TOOL_WORKER_PATH, [], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })

    let settled = false
    let timeoutId = null

    if (runState) {
      runState.activeWorker = child
    }

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timeoutId) clearTimeout(timeoutId)

      child.removeAllListeners('message')
      child.removeAllListeners('error')
      child.removeAllListeners('exit')

      if (runState?.activeWorker === child) {
        runState.activeWorker = null
      }

      if (child.connected) child.disconnect()
      if (!child.killed) child.kill()

      resolve(result)
    }

    timeoutId = setTimeout(() => {
      finish({ success: false, error: `${toolName} timed out after 120s`, workerFailure: true })
    }, 120000)

    child.on('message', (message) => {
      if (!message || typeof message !== 'object') return

      if (runState?.cancelled) {
        finish({ success: false, error: 'Agent run cancelled', cancelled: true, workerFailure: true })
        return
      }

      if (runState?.toolCancellation?.requested) {
        finish(createCancelledToolResult({ toolCancelled: true, toolName }))
        return
      }

      if (message.type === 'progress') {
        onProgress?.(message.payload)
        return
      }

      if (message.type === 'result') {
        finish(message.payload)
      }
    })

    child.on('error', (error) => {
      if (runState?.toolCancellation?.requested) {
        finish(createCancelledToolResult({ toolCancelled: true, toolName }))
        return
      }

      finish({ success: false, error: error.message || 'Tool worker failed', workerFailure: true })
    })

    child.on('exit', (code) => {
      if (!settled) {
        if (runState?.toolCancellation?.requested) {
          finish(createCancelledToolResult({ toolCancelled: true, toolName }))
          return
        }

        finish({
          success: false,
          error: code === 0 ? 'Tool worker exited before returning a result' : `Tool worker exited with code ${code}`,
          workerFailure: true,
        })
      }
    })

    child.send({ toolName, baseDir, args })
  })
}

function runGitCommand(args, cwd, runState) {
  return runExecFileCommand('git', args, { cwd, timeout: 30000 }, runState, (error, stdout, stderr) => ({
    success: !error,
    stdout: stdout || '',
    stderr: stderr || '',
    exitCode: error?.code || 0,
    error: error ? (stderr || stdout || error.message || 'Git command failed').trim() : null,
  }))
}

function runGhCommand(args, cwd, runState) {
  return runExecFileCommand(resolveGhExecutablePath(), args, { cwd, timeout: 30000 }, runState, (error, stdout, stderr) => ({
    success: !error,
    stdout: stdout || '',
    stderr: stderr || '',
    exitCode: typeof error?.code === 'number' ? error.code : 0,
    error: error ? (stderr || stdout || error.message || 'GitHub CLI command failed').trim() : null,
    missing: error?.code === 'ENOENT',
  }))
}

async function resolveGitWorkingDirectory(baseDir, runState) {
  const probe = await runGitCommand(['rev-parse', '--show-toplevel'], baseDir, runState)
  if (probe.cancelled) {
    return probe
  }

  if (!probe.success) {
    return {
      success: false,
      notGitRepo: true,
      error: 'Working directory is not inside a git repository. Select a repository root or a folder inside a repository.',
      stderr: probe.stderr,
      stdout: probe.stdout,
      exitCode: probe.exitCode,
    }
  }

  return {
    success: true,
    repoRoot: probe.stdout.trim(),
  }
}

async function runGitTool(baseDir, args, runState) {
  const gitDir = await resolveGitWorkingDirectory(baseDir, runState)
  if (!gitDir.success || gitDir.cancelled) {
    return gitDir
  }

  const result = await runGitCommand(args, gitDir.repoRoot, runState)
  return {
    ...result,
    repoRoot: gitDir.repoRoot,
  }
}

function runShellCommand(command, cwd, runState) {
  return runExecCommand(command, { cwd, timeout: 120000 }, runState, (error, stdout, stderr) => ({
    success: !error,
    stdout: stdout || '',
    stderr: stderr || '',
    exitCode: error?.code || 0,
    error: error ? (stderr || stdout || error.message || 'Command failed').trim() : null,
  }))
}

function quoteShellArgument(value) {
  return `"${String(value || '').replace(/"/g, '\\"')}"`
}

function resolveValidationContext(workingDir, requestedPath) {
  if (!requestedPath) {
    return { baseDir: workingDir, explicitTargetPath: null }
  }

  const resolvedPath = resolveToolPath(workingDir, requestedPath)

  try {
    const stats = fs.statSync(resolvedPath)
    if (stats.isDirectory()) {
      return { baseDir: resolvedPath, explicitTargetPath: null }
    }

    return { baseDir: path.dirname(resolvedPath), explicitTargetPath: resolvedPath }
  } catch {
    if (path.extname(resolvedPath)) {
      return { baseDir: path.dirname(resolvedPath), explicitTargetPath: resolvedPath }
    }

    return { baseDir: resolvedPath, explicitTargetPath: null }
  }
}

async function runValidationTool(kind, workingDir, requestedPath, runState) {
  const { baseDir, explicitTargetPath } = resolveValidationContext(workingDir, requestedPath)
  const validation = getValidationCommand(kind, baseDir, explicitTargetPath)

  if (validation.error) {
    return {
      success: false,
      error: validation.error,
    }
  }

  const validationCwd = validation.cwd || baseDir
  const result = await runShellCommand(validation.command, validationCwd, runState)
  return {
    ...result,
    command: validation.command,
    runner: validation.label,
    workingDirectory: validationCwd,
  }
}

let cachedGhExecutablePath = null

function resolveGhExecutablePath() {
  if (cachedGhExecutablePath) {
    return cachedGhExecutablePath
  }

  if (process.platform === 'win32') {
    const absoluteCandidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'GitHub CLI', 'gh.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe'),
    ].filter(Boolean)

    const discoveredAbsolute = absoluteCandidates.find((candidate) => fs.existsSync(candidate))
    cachedGhExecutablePath = discoveredAbsolute || 'gh.exe'
    return cachedGhExecutablePath
  }

  cachedGhExecutablePath = 'gh'
  return cachedGhExecutablePath
}


function parseGitHubRepoSlug(remoteUrl) {
  if (!remoteUrl) return null

  const normalized = remoteUrl.trim().replace(/\.git$/i, '')
  const sshMatch = normalized.match(/github\.com[:/]([^/]+\/[^/]+)$/i)
  if (sshMatch) return sshMatch[1]

  return null
}


async function getGitHubStatus(baseDir, runState) {
  const status = {
    success: true,
    available: false,
    authenticated: false,
    account: '',
    repo: false,
    repoRoot: '',
    remote: '',
    repoSlug: '',
    branch: '',
    authMessage: '',
    repoMessage: '',
    message: '',
  }

  const ghAuth = await runGhCommand(['auth', 'status', '--hostname', 'github.com'], baseDir, runState)
  if (ghAuth.cancelled) return ghAuth
  status.available = !ghAuth.missing

  if (!status.available) {
    status.authMessage = 'GitHub CLI not installed. Install gh to enable GitHub workflows.'
  } else if (ghAuth.success) {
    status.authenticated = true
    const login = await runGhCommand(['api', 'user', '--jq', '.login'], baseDir, runState)
    if (login.success) {
      status.account = login.stdout.trim()
    }
    status.authMessage = status.account
      ? `Authenticated with gh as ${status.account}.`
      : 'Authenticated with gh.'
  } else {
    status.authMessage = ghAuth.error || 'GitHub CLI is installed but not authenticated.'
  }

  const gitDir = await resolveGitWorkingDirectory(baseDir, runState)
  if (!gitDir.success || gitDir.cancelled) {
    status.repoMessage = 'Working directory is not inside a git repository.'
    status.message = status.authMessage || status.repoMessage
    return gitDir.cancelled ? gitDir : status
  }

  status.repo = true
  status.repoRoot = gitDir.repoRoot

  const branch = await runGitCommand(['branch', '--show-current'], gitDir.repoRoot, runState)
  if (branch.success) {
    status.branch = branch.stdout.trim()
  }

  const remote = await runGitCommand(['remote', 'get-url', 'origin'], gitDir.repoRoot, runState)
  if (remote.cancelled) return remote
  if (!remote.success) {
    status.repoMessage = 'Git repository has no origin remote configured.'
    status.message = status.authMessage || status.repoMessage
    return status
  }

  status.remote = remote.stdout.trim()
  status.repoSlug = parseGitHubRepoSlug(status.remote) || ''
  status.repoMessage = status.repoSlug
    ? `Origin remote: ${status.repoSlug}`
    : 'Origin remote is configured but is not a GitHub repository.'

  if (status.available && status.authenticated && status.repoSlug) {
    status.message = status.account
      ? `GitHub ready as ${status.account} for ${status.repoSlug}.`
      : `GitHub ready for ${status.repoSlug}.`
  } else {
    status.message = status.authMessage || status.repoMessage
  }

  return status
}

async function startGitHubLogin(baseDir) {
  const status = await getGitHubStatus(baseDir)

  if (!status.available) {
    return { success: false, error: status.authMessage || 'GitHub CLI not installed.' }
  }

  if (status.authenticated) {
    return { success: true, message: 'GitHub CLI is already authenticated.' }
  }

  const ghPath = resolveGhExecutablePath()
  const ghArgs = ['auth', 'login', '--web', '--git-protocol', 'https', '--skip-ssh-key', '--hostname', 'github.com']

  try {
    if (process.platform === 'win32') {
      const command = `& '${ghPath.replace(/'/g, "''")}' ${ghArgs.map((arg) => `'${arg.replace(/'/g, "''")}'`).join(' ')}`

      const child = spawn('cmd.exe', ['/c', 'start', '', 'powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
    } else {
      const child = spawn(ghPath, ghArgs, {
        cwd: baseDir || process.cwd(),
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
    }

    return {
      success: true,
      message: 'GitHub login launched in a separate window. Complete authentication there and then return to Bliss Agent.',
    }
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Failed to launch GitHub authentication.',
    }
  }
}

async function ensureGitHubRepoReady(baseDir, runState) {
  const status = await getGitHubStatus(baseDir, runState)
  if (status.cancelled) return status

  if (!status.available) {
    return { success: false, error: status.authMessage || 'GitHub CLI not installed.' }
  }

  if (!status.authenticated) {
    return { success: false, error: status.authMessage || 'GitHub CLI is not authenticated.' }
  }

  if (!status.repo) {
    return { success: false, error: status.repoMessage || 'Working directory is not inside a git repository.' }
  }

  if (!status.repoSlug) {
    return { success: false, error: status.repoMessage || 'Origin remote is not a GitHub repository.' }
  }

  return { success: true, status }
}

function parseGhJson(result) {
  if (!result.success) return result

  try {
    return { success: true, data: JSON.parse(result.stdout || '{}') }
  } catch (error) {
    return { success: false, error: `Invalid JSON from GitHub CLI: ${error.message}` }
  }
}

function normalizeGitHubCliList(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
  }

  if (typeof value !== 'string') return []

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function hasToolArg(args, key) {
  return Boolean(args) && Object.prototype.hasOwnProperty.call(args, key)
}

async function getGitHubRepoInfo(baseDir, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const ghResult = await runGhCommand([
    'repo',
    'view',
    '--json',
    'nameWithOwner,description,url,defaultBranchRef,isPrivate'
  ], ready.status.repoRoot, runState)
  const parsed = parseGhJson(ghResult)
  if (!parsed.success) return parsed

  return {
    success: true,
    repoInfo: parsed.data,
    message: `Repository ${parsed.data.nameWithOwner} is ready on ${parsed.data.defaultBranchRef?.name || 'unknown branch'}.`,
  }
}

async function getGitHubIssueView(baseDir, issueNumber, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const ghResult = await runGhCommand([
    'issue',
    'view',
    String(issueNumber),
    '--json',
    'number,title,body,state,author,labels,assignees,url'
  ], ready.status.repoRoot, runState)
  const parsed = parseGhJson(ghResult)
  if (!parsed.success) return parsed

  return {
    success: true,
    issue: parsed.data,
    message: `Issue #${parsed.data.number}: ${parsed.data.title}`,
  }
}

async function createGitHubIssue(baseDir, args, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const ghArgs = [
    'issue',
    'create',
    '--title',
    args.title,
    '--body',
    typeof args.body === 'string' ? args.body.trim() : '',
  ]

  for (const label of normalizeGitHubCliList(args.labels)) {
    ghArgs.push('--label', label)
  }

  for (const assignee of normalizeGitHubCliList(args.assignees)) {
    ghArgs.push('--assignee', assignee)
  }

  const result = await runGhCommand(ghArgs, ready.status.repoRoot, runState)
  if (result.cancelled) return result
  if (!result.success) return result

  const issueUrl = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || ''
  return {
    success: true,
    url: issueUrl,
    stdout: result.stdout,
    message: issueUrl ? `Issue created: ${issueUrl}` : 'Issue created successfully.',
  }
}

async function editGitHubIssue(baseDir, args, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const ghArgs = ['issue', 'edit', String(args.number)]

  if (hasToolArg(args, 'title')) {
    ghArgs.push('--title', String(args.title ?? ''))
  }

  if (hasToolArg(args, 'body')) {
    ghArgs.push('--body', String(args.body ?? ''))
  }

  for (const label of normalizeGitHubCliList(args.addLabels)) {
    ghArgs.push('--add-label', label)
  }

  for (const label of normalizeGitHubCliList(args.removeLabels)) {
    ghArgs.push('--remove-label', label)
  }

  for (const assignee of normalizeGitHubCliList(args.addAssignees)) {
    ghArgs.push('--add-assignee', assignee)
  }

  for (const assignee of normalizeGitHubCliList(args.removeAssignees)) {
    ghArgs.push('--remove-assignee', assignee)
  }

  if (ghArgs.length === 3) {
    return { success: false, error: 'Provide at least one issue field to edit.' }
  }

  const result = await runGhCommand(ghArgs, ready.status.repoRoot, runState)
  if (result.cancelled) return result
  if (!result.success) return result

  return {
    success: true,
    stdout: result.stdout,
    message: `Issue #${args.number} updated successfully.`,
  }
}

async function updateGitHubIssueState(baseDir, args, runState, action) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const ghArgs = ['issue', action, String(args.number)]

  if (typeof args.comment === 'string' && args.comment.trim()) {
    ghArgs.push('--comment', args.comment.trim())
  }

  if (action === 'close' && typeof args.reason === 'string' && args.reason.trim()) {
    ghArgs.push('--reason', args.reason.trim())
  }

  const result = await runGhCommand(ghArgs, ready.status.repoRoot, runState)
  if (result.cancelled) return result
  if (!result.success) return result

  return {
    success: true,
    stdout: result.stdout,
    message: `Issue #${args.number} ${action}d successfully.`,
  }
}

async function commentOnGitHubIssue(baseDir, args, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const result = await runGhCommand([
    'issue',
    'comment',
    String(args.number),
    '--body',
    String(args.body || '').trim(),
  ], ready.status.repoRoot, runState)
  if (result.cancelled) return result
  if (!result.success) return result

  const commentUrl = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || ''
  return {
    success: true,
    url: commentUrl,
    stdout: result.stdout,
    message: commentUrl ? `Issue #${args.number} commented: ${commentUrl}` : `Comment added to issue #${args.number}.`,
  }
}

async function getGitHubPullRequestView(baseDir, prNumber, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const ghResult = await runGhCommand([
    'pr',
    'view',
    String(prNumber),
    '--json',
    'number,title,body,state,isDraft,author,headRefName,baseRefName,reviewDecision,mergeable,url'
  ], ready.status.repoRoot, runState)
  const parsed = parseGhJson(ghResult)
  if (!parsed.success) return parsed

  return {
    success: true,
    pullRequest: parsed.data,
    message: `PR #${parsed.data.number}: ${parsed.data.title}`,
  }
}

async function getGitHubPullRequestReviewComments(baseDir, prNumber, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const ghResult = await runGhCommand([
    'api',
    `repos/${ready.status.repoSlug}/pulls/${prNumber}/comments`
  ], ready.status.repoRoot, runState)
  const parsed = parseGhJson(ghResult)
  if (!parsed.success) return parsed

  return {
    success: true,
    comments: parsed.data,
    message: parsed.data.length
      ? `Loaded ${parsed.data.length} review comment(s) for PR #${prNumber}.`
      : `No review comments found for PR #${prNumber}.`,
  }
}

async function editGitHubPullRequest(baseDir, args, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const ghArgs = ['pr', 'edit', String(args.number)]

  if (hasToolArg(args, 'title')) {
    ghArgs.push('--title', String(args.title ?? ''))
  }

  if (hasToolArg(args, 'body')) {
    ghArgs.push('--body', String(args.body ?? ''))
  }

  if (typeof args.base === 'string' && args.base.trim()) {
    ghArgs.push('--base', args.base.trim())
  }

  for (const label of normalizeGitHubCliList(args.addLabels)) {
    ghArgs.push('--add-label', label)
  }

  for (const label of normalizeGitHubCliList(args.removeLabels)) {
    ghArgs.push('--remove-label', label)
  }

  for (const assignee of normalizeGitHubCliList(args.addAssignees)) {
    ghArgs.push('--add-assignee', assignee)
  }

  for (const assignee of normalizeGitHubCliList(args.removeAssignees)) {
    ghArgs.push('--remove-assignee', assignee)
  }

  if (ghArgs.length === 3) {
    return { success: false, error: 'Provide at least one PR field to edit.' }
  }

  const result = await runGhCommand(ghArgs, ready.status.repoRoot, runState)
  if (result.cancelled) return result
  if (!result.success) return result

  return {
    success: true,
    stdout: result.stdout,
    message: `PR #${args.number} updated successfully.`,
  }
}

async function submitGitHubPullRequestReview(baseDir, args, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const normalizedEvent = String(args.event || '').trim().toLowerCase().replace(/-/g, '_')
  const reviewFlag = {
    comment: '--comment',
    approve: '--approve',
    request_changes: '--request-changes',
    requestchanges: '--request-changes',
  }[normalizedEvent]

  if (!reviewFlag) {
    return { success: false, error: 'Review event must be one of: comment, approve, request_changes.' }
  }

  const reviewBody = hasToolArg(args, 'body') ? String(args.body ?? '') : ''
  if (reviewFlag === '--comment' && !reviewBody.trim()) {
    return { success: false, error: 'Review body is required for comment reviews.' }
  }

  const ghArgs = ['pr', 'review', String(args.number), reviewFlag]
  if (hasToolArg(args, 'body')) {
    ghArgs.push('--body', reviewBody)
  }

  const result = await runGhCommand(ghArgs, ready.status.repoRoot, runState)
  if (result.cancelled) return result
  if (!result.success) return result

  return {
    success: true,
    stdout: result.stdout,
    message: `Review submitted for PR #${args.number} (${normalizedEvent}).`,
  }
}

async function updateGitHubPullRequestState(baseDir, args, runState, action) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const ghArgs = ['pr', action, String(args.number)]

  if (typeof args.comment === 'string' && args.comment.trim()) {
    ghArgs.push('--comment', args.comment.trim())
  }

  if (action === 'close' && args.deleteBranch) {
    ghArgs.push('--delete-branch')
  }

  const result = await runGhCommand(ghArgs, ready.status.repoRoot, runState)
  if (result.cancelled) return result
  if (!result.success) return result

  return {
    success: true,
    stdout: result.stdout,
    message: `PR #${args.number} ${action}ed successfully.`,
  }
}

async function commentOnGitHubPullRequest(baseDir, args, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const result = await runGhCommand([
    'pr',
    'comment',
    String(args.number),
    '--body',
    String(args.body || '').trim(),
  ], ready.status.repoRoot, runState)
  if (result.cancelled) return result
  if (!result.success) return result

  const commentUrl = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || ''
  return {
    success: true,
    url: commentUrl,
    stdout: result.stdout,
    message: commentUrl ? `PR #${args.number} commented: ${commentUrl}` : `Comment added to PR #${args.number}.`,
  }
}

async function mergeGitHubPullRequest(baseDir, args, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const normalizedMethod = String(args.method || 'merge').trim().toLowerCase()
  const mergeFlag = {
    merge: '--merge',
    squash: '--squash',
    rebase: '--rebase',
  }[normalizedMethod]

  if (!mergeFlag) {
    return { success: false, error: 'Merge method must be one of: merge, squash, rebase.' }
  }

  const ghArgs = ['pr', 'merge', String(args.number), mergeFlag]

  if (typeof args.subject === 'string' && args.subject.trim()) {
    ghArgs.push('--subject', args.subject.trim())
  }

  if (hasToolArg(args, 'body')) {
    ghArgs.push('--body', String(args.body ?? ''))
  }

  if (args.deleteBranch) {
    ghArgs.push('--delete-branch')
  }

  if (args.auto) {
    ghArgs.push('--auto')
  }

  if (args.admin) {
    ghArgs.push('--admin')
  }

  const result = await runGhCommand(ghArgs, ready.status.repoRoot, runState)
  if (result.cancelled) return result
  if (!result.success) return result

  return {
    success: true,
    stdout: result.stdout,
    message: `PR #${args.number} merge requested with ${normalizedMethod}.`,
  }
}

async function buildPullRequestBody(baseDir, args, runState) {
  if (args.body && args.body.trim()) {
    return args.body.trim()
  }

  const summary = args.summary?.trim() || 'Update prepared by Bliss Agent.'
  const validation = args.validation?.trim() || 'Not run'

  const status = await runGitTool(baseDir, ['status', '--short'], runState)
  if (status.cancelled) return null
  const changedFiles = status.success
    ? status.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 12)
    : []

  const changesBlock = changedFiles.length
    ? changedFiles.map((line) => `- ${line}`).join('\n')
    : '- No local file summary available.'

  return [
    '## Summary',
    summary,
    '',
    '## Changes',
    changesBlock,
    '',
    '## Validation',
    validation,
  ].join('\n')
}

async function createGitHubPullRequest(baseDir, args, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const body = await buildPullRequestBody(baseDir, args, runState)
  if (body === null) return createCancelledToolResult()

  const ghArgs = [
    'pr',
    'create',
    '--title',
    args.title,
    '--body',
    body,
  ]

  if (args.base) {
    ghArgs.push('--base', args.base)
  }

  if (args.head) {
    ghArgs.push('--head', args.head)
  }

  if (args.draft !== false) {
    ghArgs.push('--draft')
  }

  const result = await runGhCommand(ghArgs, ready.status.repoRoot, runState)
  if (result.cancelled) return result
  if (!result.success) {
    return result
  }

  const prUrl = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || ''
  return {
    success: true,
    url: prUrl,
    stdout: result.stdout,
    body,
    message: prUrl ? `Draft PR created: ${prUrl}` : 'Draft PR created successfully.',
  }
}


function readPackageJsonScripts(baseDir) {
  const packageJsonPath = path.join(baseDir, 'package.json')
  if (!fs.existsSync(packageJsonPath)) return null

  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
    return parsed.scripts || {}
  } catch {
    return null
  }
}

function hasAnyFile(baseDir, extensions) {
  try {
    return walkFiles(baseDir, 5000).some((filePath) => extensions.some((extension) => filePath.endsWith(extension)))
  } catch {
    return false
  }
}

function sortCandidatePaths(baseDir, paths) {
  return [...paths].sort((left, right) => {
    const leftRelative = toRelativeToolPath(baseDir, left)
    const rightRelative = toRelativeToolPath(baseDir, right)
    const leftDepth = leftRelative.split(/[\\/]/).length
    const rightDepth = rightRelative.split(/[\\/]/).length
    if (leftDepth !== rightDepth) return leftDepth - rightDepth
    return leftRelative.localeCompare(rightRelative)
  })
}

function resolveExplicitProjectDirectory(explicitTargetPath) {
  if (!explicitTargetPath) return null

  try {
    const stats = fs.statSync(explicitTargetPath)
    return stats.isDirectory() ? explicitTargetPath : path.dirname(explicitTargetPath)
  } catch {
    return path.extname(explicitTargetPath) ? path.dirname(explicitTargetPath) : explicitTargetPath
  }
}

function findNestedPackageJsonDirs(baseDir, explicitTargetPath = null) {
  const explicitDir = resolveExplicitProjectDirectory(explicitTargetPath)
  if (explicitDir) {
    const explicitPackageJson = path.join(explicitDir, 'package.json')
    return fs.existsSync(explicitPackageJson) ? [explicitDir] : []
  }

  const packageJsonPath = path.join(baseDir, 'package.json')
  if (fs.existsSync(packageJsonPath)) {
    return [baseDir]
  }

  try {
    const candidates = walkFiles(baseDir, 5000)
      .filter((filePath) => path.basename(filePath).toLowerCase() === 'package.json')
      .map((filePath) => path.dirname(filePath))

    return sortCandidatePaths(baseDir, [...new Set(candidates)])
  } catch {
    return []
  }
}

function getNodeValidationCommand(kind, baseDir, explicitTargetPath = null) {
  const npmScriptCandidates = {
    build: ['build'],
    test: ['test'],
    lint: ['lint', 'eslint', 'check'],
  }

  const packageDirs = findNestedPackageJsonDirs(baseDir, explicitTargetPath)
  for (const packageDir of packageDirs) {
    const scripts = readPackageJsonScripts(packageDir)
    if (!scripts) continue

    const scriptName = npmScriptCandidates[kind].find((candidate) => scripts[candidate])
    if (!scriptName) continue

    return {
      command: `npm run ${scriptName}`,
      label: `npm:${scriptName}`,
      cwd: packageDir,
    }
  }

  return null
}

function findPythonProjectDirs(baseDir, explicitTargetPath = null) {
  const explicitDir = resolveExplicitProjectDirectory(explicitTargetPath)
  const markerFiles = new Set(['pyproject.toml', 'setup.py', 'requirements.txt', 'pytest.ini', 'tox.ini'])

  if (explicitDir) {
    const hasMarker = [...markerFiles].some((marker) => fs.existsSync(path.join(explicitDir, marker)))
    return hasMarker ? [explicitDir] : []
  }

  try {
    const candidates = walkFiles(baseDir, 5000)
      .filter((filePath) => markerFiles.has(path.basename(filePath).toLowerCase()))
      .map((filePath) => path.dirname(filePath))

    return sortCandidatePaths(baseDir, [...new Set(candidates)])
  } catch {
    return []
  }
}

function getPythonValidationCommand(kind, baseDir, explicitTargetPath = null) {
  const projectDirs = findPythonProjectDirs(baseDir, explicitTargetPath)
  if (!projectDirs.length) return null

  const selectedDir = projectDirs[0]

  if (kind === 'build') {
    return {
      command: 'python -m build',
      label: 'python -m build',
      cwd: selectedDir,
    }
  }

  if (kind === 'test') {
    return {
      command: 'python -m pytest',
      label: 'python -m pytest',
      cwd: selectedDir,
    }
  }

  if (kind === 'lint') {
    return {
      command: 'python -m ruff check .',
      label: 'python -m ruff check',
      cwd: selectedDir,
    }
  }

  return null
}

function getDotnetValidationTarget(baseDir, kind, explicitTargetPath = null) {
  if (explicitTargetPath && /\.(sln|csproj)$/i.test(explicitTargetPath)) {
    return explicitTargetPath
  }

  let candidates = []
  try {
    candidates = walkFiles(baseDir, 5000).filter((filePath) => /\.(sln|csproj)$/i.test(filePath))
  } catch {
    return null
  }

  if (!candidates.length) return null

  const solutionCandidates = candidates.filter((filePath) => filePath.endsWith('.sln'))
  const projectCandidates = candidates.filter((filePath) => filePath.endsWith('.csproj'))
  const preferredTestProjects = projectCandidates.filter((filePath) => /test/i.test(path.basename(filePath)) || /tests?/i.test(path.dirname(filePath)))

  if (solutionCandidates.length) {
    return sortCandidatePaths(baseDir, solutionCandidates)[0]
  }

  if (kind === 'test' && preferredTestProjects.length) {
    return sortCandidatePaths(baseDir, preferredTestProjects)[0]
  }

  return sortCandidatePaths(baseDir, projectCandidates)[0] || null
}

function getValidationCommand(kind, baseDir, explicitTargetPath = null) {
  const nodeValidation = getNodeValidationCommand(kind, baseDir, explicitTargetPath)
  if (nodeValidation) {
    return nodeValidation
  }

  const hasDotnetProject = hasAnyFile(baseDir, ['.sln', '.csproj'])
  if (hasDotnetProject) {
    const dotnetTarget = getDotnetValidationTarget(baseDir, kind, explicitTargetPath)
    if (!dotnetTarget) {
      return { error: `No .NET project or solution file found for ${kind}` }
    }

    const relativeTarget = toRelativeToolPath(baseDir, dotnetTarget)
    if (kind === 'build') {
      return {
        command: `dotnet build ${quoteShellArgument(relativeTarget)}`,
        label: `dotnet build ${relativeTarget}`,
      }
    }
    if (kind === 'test') {
      return {
        command: `dotnet test ${quoteShellArgument(relativeTarget)}`,
        label: `dotnet test ${relativeTarget}`,
      }
    }
    return { error: 'No standard lint command detected for this .NET project' }
  }

  const pythonValidation = getPythonValidationCommand(kind, baseDir, explicitTargetPath)
  if (pythonValidation) {
    return pythonValidation
  }

  return {
    error: `No supported ${kind} command detected for this project`,
  }
}

function getValidationKindFromCommand(command) {
  const normalized = String(command || '').trim().toLowerCase()
  if (!normalized || /[;&|]/.test(normalized)) return null

  if (/^(dotnet\s+build|npm\s+(run\s+)?build|pnpm\s+build|yarn\s+build|python(\.exe)?\s+-m\s+build|py\s+-m\s+build)(\s|$)/i.test(normalized)) {
    return 'build'
  }

  if (/^(dotnet\s+test|npm\s+(run\s+)?test|pnpm\s+test|yarn\s+test|pytest|python(\.exe)?\s+-m\s+pytest|py\s+-m\s+pytest)(\s|$)/i.test(normalized)) {
    return 'test'
  }

  if (/^(npm\s+run\s+(lint|eslint|check)|pnpm\s+(lint|eslint|check)|yarn\s+(lint|eslint|check)|ruff\s+check|python(\.exe)?\s+-m\s+ruff\s+check|py\s+-m\s+ruff\s+check)(\s|$)/i.test(normalized)) {
    return 'lint'
  }

  return null
}

function getValidationTargetFromCommand(command) {
  const trimmed = String(command || '').trim()
  const dotnetMatch = trimmed.match(/^dotnet\s+(?:build|test)\s+(?:--[^\s]+\s+)*(?:"([^"]+)"|'([^']+)'|([^\s-][^\s]*))(?:\s|$)/i)
  if (dotnetMatch) {
    return dotnetMatch[1] || dotnetMatch[2] || dotnetMatch[3] || null
  }

  return null
}


async function findFilesTool(baseDir, args) {
  const searchRoot = resolveToolPath(baseDir, args.path || '.')
  const query = (args.query || '').toLowerCase()
  const maxResults = Math.max(1, Math.min(Number(args.maxResults) || 200, 1000))
  const files = (await walkFilesAsync(searchRoot, 5000))
    .map((filePath) => toRelativeToolPath(baseDir, filePath))
    .filter((filePath) => !query || filePath.toLowerCase().includes(query))
    .slice(0, maxResults)

  const ignoredDirectories = !query && files.length === 0
    ? await listIgnoredDirectoriesAsync(searchRoot)
    : []

  const message = files.length
    ? `Found ${files.length} file(s)`
    : ignoredDirectories.length
      ? `No files found outside ignored directories: ${ignoredDirectories.join(', ')}`
      : 'No files found'

  return {
    success: true,
    files,
    ignoredDirectories,
    message,
  }
}

async function searchTextTool(baseDir, args) {
  const searchRoot = resolveToolPath(baseDir, args.path || '.')
  const maxResults = Math.max(1, Math.min(Number(args.maxResults) || 100, 500))
  const expression = args.isRegex
    ? new RegExp(args.query, args.caseSensitive ? 'g' : 'gi')
    : new RegExp(escapeRegExp(args.query), args.caseSensitive ? 'g' : 'gi')

  let targetFiles = []
  try {
    const stats = await fs.promises.stat(searchRoot)
    targetFiles = stats.isFile() ? [searchRoot] : await walkFilesAsync(searchRoot, 5000)
  } catch (error) {
    return { success: false, error: error.message }
  }

  const matches = []

  for (let fileIndex = 0; fileIndex < targetFiles.length; fileIndex++) {
    const filePath = targetFiles[fileIndex]
    if (matches.length >= maxResults) break
    if (!(await isLikelyTextFileAsync(filePath))) continue

    let content = ''
    try {
      content = await fs.promises.readFile(filePath, 'utf-8')
    } catch {
      continue
    }

    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
      expression.lastIndex = 0
      if (!expression.test(lines[index])) continue

      matches.push({
        path: toRelativeToolPath(baseDir, filePath),
        lineNumber: index + 1,
        line: lines[index].trim(),
      })

      if (matches.length >= maxResults) break
    }

    if (fileIndex % 10 === 0) {
      await yieldToEventLoop()
    }
  }

  return {
    success: true,
    matches,
    message: matches.length ? `Found ${matches.length} match(es)` : 'No matches found',
  }
}

function executeTool(name, args, workingDir, onProgress, runState) {
  return new Promise((resolve) => {
    try {
      const baseDir = workingDir || process.cwd()
      ensureRunNotCancelled(runState)

      switch (name) {
        case 'find_files': {
          runHeavyToolInChildProcess(name, baseDir, args, onProgress, runState).then(async (result) => {
            if (!result.success && result.workerFailure) {
              if (result.cancelled) {
                resolve(result)
                return
              }

              logMain('find_files worker failed, falling back to main process', result.error)
              resolve(await findFilesTool(baseDir, args))
              return
            }

            resolve(result)
          })
          break
        }
        case 'search_text': {
          runHeavyToolInChildProcess(name, baseDir, args, onProgress, runState).then(async (result) => {
            if (!result.success && result.workerFailure) {
              if (result.cancelled) {
                resolve(result)
                return
              }

              logMain('search_text worker failed, falling back to main process', result.error)
              resolve(await searchTextTool(baseDir, args))
              return
            }

            resolve(result)
          })
          break
        }
        case 'read_file': {
          const content = fs.readFileSync(resolveToolPath(baseDir, args.path), 'utf-8')
          resolve({ success: true, content })
          break
        }
        case 'read_file_range': {
          const filePath = resolveToolPath(baseDir, args.path)
          const startLine = Math.max(1, Number(args.startLine) || 1)
          const endLine = Math.max(startLine, Number(args.endLine) || startLine)
          const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)
          const content = lines.slice(startLine - 1, endLine).join('\n')
          resolve({ success: true, content, startLine, endLine })
          break
        }
        case 'apply_patch': {
          const filePath = resolveToolPath(baseDir, args.path)
          const original = fs.readFileSync(filePath, 'utf-8')
          const occurrences = args.oldText ? original.split(args.oldText).length - 1 : 0

          if (!args.oldText) {
            resolve({ success: false, error: 'oldText is required for apply_patch' })
            break
          }

          if (occurrences === 0) {
            resolve({ success: false, error: 'oldText was not found in the file' })
            break
          }

          if (!args.replaceAll && occurrences > 1) {
            resolve({ success: false, error: 'oldText matched more than once; refine the patch target or set replaceAll' })
            break
          }

          const updated = args.replaceAll
            ? original.split(args.oldText).join(args.newText)
            : original.replace(args.oldText, args.newText)

          fs.writeFileSync(filePath, updated, 'utf-8')
          resolve({
            success: true,
            message: `Patched ${toRelativeToolPath(baseDir, filePath)} (${args.replaceAll ? occurrences : 1} replacement${(args.replaceAll ? occurrences : 1) === 1 ? '' : 's'})`,
            replacements: args.replaceAll ? occurrences : 1,
          })
          break
        }
        case 'write_file': {
          const filePath = resolveToolPath(baseDir, args.path)
          fs.mkdirSync(path.dirname(filePath), { recursive: true })
          fs.writeFileSync(filePath, args.content, 'utf-8')
          resolve({ success: true, message: `File written: ${filePath}` })
          break
        }
        case 'list_directory': {
          const entries = fs.readdirSync(resolveToolPath(baseDir, args.path), { withFileTypes: true })
          const result = entries.map(e => ({
            name: e.name,
            type: e.isDirectory() ? 'dir' : 'file'
          }))
          resolve({ success: true, entries: result })
          break
        }
        case 'run_command': {
          const commandCwd = args.cwd ? resolveToolPath(baseDir, args.cwd) : baseDir
          const validationKind = getValidationKindFromCommand(args.command)
          if (validationKind) {
            runValidationTool(validationKind, commandCwd, getValidationTargetFromCommand(args.command), runState)
              .then((result) => resolve({
                ...result,
                routedFrom: 'run_command',
                originalCommand: args.command,
              }))
            break
          }

          runExecCommand(args.command, { cwd: commandCwd, timeout: 30000 }, runState, (err, stdout, stderr) => ({
            success: !err,
            stdout: stdout || '',
            stderr: stderr || '',
            exitCode: err?.code || 0,
            error: err ? (stderr || stdout || err.message || 'Command failed').trim() : null,
          })).then(resolve)
          break
        }
        case 'git_status': {
          runGitTool(baseDir, ['status', '--short', '--branch'], runState).then(resolve)
          break
        }
        case 'git_diff': {
          resolveGitWorkingDirectory(baseDir, runState).then((gitDir) => {
            if (!gitDir.success || gitDir.cancelled) {
              resolve(gitDir)
              return
            }

            const diffArgs = ['diff']
            if (args.staged) diffArgs.push('--staged')
            if (args.path) {
              diffArgs.push('--', resolveToolPath(baseDir, args.path))
            }

            runGitCommand(diffArgs, gitDir.repoRoot, runState).then((result) => resolve({ ...result, repoRoot: gitDir.repoRoot }))
          })
          break
        }
        case 'git_create_branch': {
          runGitTool(baseDir, ['checkout', '-b', args.name], runState).then(resolve)
          break
        }
        case 'git_add': {
          resolveGitWorkingDirectory(baseDir, runState).then((gitDir) => {
            if (!gitDir.success || gitDir.cancelled) {
              resolve(gitDir)
              return
            }

            const gitArgs = ['add']
            if (args.all) {
              gitArgs.push('--all')
            } else if (args.path) {
              gitArgs.push('--', resolveToolPath(baseDir, args.path))
            } else {
              gitArgs.push('--all')
            }

            runGitCommand(gitArgs, gitDir.repoRoot, runState).then((result) => resolve({ ...result, repoRoot: gitDir.repoRoot }))
          })
          break
        }
        case 'git_commit': {
          runGitTool(baseDir, ['commit', '-m', args.message], runState).then(resolve)
          break
        }
        case 'github_auth_status': {
          getGitHubStatus(baseDir, runState).then(resolve)
          break
        }
        case 'github_repo_info': {
          getGitHubRepoInfo(baseDir, runState).then(resolve)
          break
        }
        case 'github_issue_view': {
          getGitHubIssueView(baseDir, args.number, runState).then(resolve)
          break
        }
        case 'github_issue_create': {
          createGitHubIssue(baseDir, args, runState).then(resolve)
          break
        }
        case 'github_issue_edit': {
          editGitHubIssue(baseDir, args, runState).then(resolve)
          break
        }
        case 'github_issue_close': {
          updateGitHubIssueState(baseDir, args, runState, 'close').then(resolve)
          break
        }
        case 'github_issue_reopen': {
          updateGitHubIssueState(baseDir, args, runState, 'reopen').then(resolve)
          break
        }
        case 'github_issue_comment': {
          commentOnGitHubIssue(baseDir, args, runState).then(resolve)
          break
        }
        case 'github_pr_view': {
          getGitHubPullRequestView(baseDir, args.number, runState).then(resolve)
          break
        }
        case 'github_pr_review_comments': {
          getGitHubPullRequestReviewComments(baseDir, args.number, runState).then(resolve)
          break
        }
        case 'github_pr_edit': {
          editGitHubPullRequest(baseDir, args, runState).then(resolve)
          break
        }
        case 'github_pr_review_submit': {
          submitGitHubPullRequestReview(baseDir, args, runState).then(resolve)
          break
        }
        case 'github_pr_close': {
          updateGitHubPullRequestState(baseDir, args, runState, 'close').then(resolve)
          break
        }
        case 'github_pr_reopen': {
          updateGitHubPullRequestState(baseDir, args, runState, 'reopen').then(resolve)
          break
        }
        case 'github_pr_comment': {
          commentOnGitHubPullRequest(baseDir, args, runState).then(resolve)
          break
        }
        case 'github_pr_merge': {
          mergeGitHubPullRequest(baseDir, args, runState).then(resolve)
          break
        }
        case 'github_pr_create': {
          createGitHubPullRequest(baseDir, args, runState).then(resolve)
          break
        }
        case 'run_build': {
          runValidationTool('build', baseDir, args.path, runState).then(resolve)
          break
        }
        case 'run_test': {
          runValidationTool('test', baseDir, args.path, runState).then(resolve)
          break
        }
        case 'run_lint': {
          runValidationTool('lint', baseDir, args.path, runState).then(resolve)
          break
        }
        case 'create_directory': {
          const dirPath = resolveToolPath(baseDir, args.path)
          fs.mkdirSync(dirPath, { recursive: true })
          resolve({ success: true, message: `Directory created: ${dirPath}` })
          break
        }
        case 'delete_file': {
          const filePath = resolveToolPath(baseDir, args.path)
          fs.unlinkSync(filePath)
          resolve({ success: true, message: `File deleted: ${filePath}` })
          break
        }
        default:
          resolve({ success: false, error: `Unknown tool: ${name}` })
      }
    } catch (e) {
      resolve({ success: false, error: e.message })
    }
  })
}

// ─── Model Provider Calls ────────────────────────────────────────────────────

function callOpenAiCompatibleChat({ hostname, path: requestPath, apiKey, model, messages, extraHeaders, runState, onAssistantContent }) {
  return new Promise((resolve, reject) => {
    if (!apiKey) {
      reject(new Error('Missing provider API key'))
      return
    }

    if (runState?.cancelled) {
      reject(createAgentCancellationError())
      return
    }

    const body = JSON.stringify({
      model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 4096,
      stream: true,
    })

    const options = {
      hostname,
      path: requestPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...extraHeaders,
      }
    }

    const req = https.request(options, (res) => {
      let data = ''
      let sseBuffer = ''
      let sawSsePayload = false
      let lastStreamResponse = null
      const streamedChoice = {
        index: 0,
        finish_reason: null,
        message: createEmptyStreamedAssistantMessage(),
      }

      const emitAssistantContent = () => {
        const safeContent = getDisplaySafeAssistantContent(streamedChoice.message.content)
        if (runState) {
          runState.partialAssistantText = safeContent
        }

        if (!safeContent || safeContent === runState?.lastEmittedAssistantText) return

        if (runState) {
          runState.lastEmittedAssistantText = safeContent
        }

        onAssistantContent?.(safeContent)
      }

      const processSseEvent = (rawEvent) => {
        const payload = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')

        if (!payload) return
        if (payload === '[DONE]') return

        sawSsePayload = true

        try {
          const parsed = JSON.parse(payload)
          lastStreamResponse = parsed
          const choice = parsed.choices?.[0]
          if (!choice) return

          if (choice.delta?.role) {
            streamedChoice.message.role = choice.delta.role
          }

          if (typeof choice.delta?.content === 'string') {
            streamedChoice.message.content += choice.delta.content
            emitAssistantContent()
          }

          if (Array.isArray(choice.delta?.tool_calls)) {
            mergeStreamedToolCalls(streamedChoice.message.tool_calls, choice.delta.tool_calls)
          }

          if (choice.finish_reason) {
            streamedChoice.finish_reason = choice.finish_reason
          }
        } catch (error) {
          logMain('Failed to parse provider stream chunk', error.message)
        }
      }

      res.on('data', chunk => data += chunk)
      res.on('data', (chunk) => {
        const chunkText = chunk.toString('utf8')
        sseBuffer += chunkText.replace(/\r\n/g, '\n')

        let boundaryIndex = sseBuffer.indexOf('\n\n')
        while (boundaryIndex !== -1) {
          const rawEvent = sseBuffer.slice(0, boundaryIndex)
          sseBuffer = sseBuffer.slice(boundaryIndex + 2)
          processSseEvent(rawEvent)
          boundaryIndex = sseBuffer.indexOf('\n\n')
        }
      })
      res.on('end', () => {
        if (runState?.activeRequest === req) {
          runState.activeRequest = null
        }

        if (runState?.cancelled) {
          reject(createAgentCancellationError())
          return
        }

        if (res.statusCode && res.statusCode >= 400) {
          try {
            const parsed = JSON.parse(data)
            const error = new Error(formatProviderErrorMessage({
              providerName: hostname,
              model,
              statusCode: res.statusCode,
              parsedError: parsed.error || parsed,
              rawBody: data,
            }))
            error.statusCode = res.statusCode
            error.model = model
            error.details = parsed.error || parsed
            reject(error)
          } catch {
            const error = new Error(formatProviderErrorMessage({
              providerName: hostname,
              model,
              statusCode: res.statusCode,
              parsedError: null,
              rawBody: data,
            }))
            error.statusCode = res.statusCode
            error.model = model
            reject(error)
          }
          return
        }

        if (sawSsePayload) {
          const trailingPayload = sseBuffer.trim()
          if (trailingPayload) {
            processSseEvent(trailingPayload)
          }

          resolve({
            id: lastStreamResponse?.id || `stream-${Date.now()}`,
            object: lastStreamResponse?.object || 'chat.completion',
            created: lastStreamResponse?.created || Math.floor(Date.now() / 1000),
            model: lastStreamResponse?.model || model,
            choices: [{
              index: streamedChoice.index,
              finish_reason: streamedChoice.finish_reason || 'stop',
              message: finalizeStreamedAssistantMessage(streamedChoice.message),
            }],
          })
          return
        }

        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(new Error(`Invalid JSON from API: ${data.slice(0, 300)}`))
        }
      })
    })

    if (runState) {
      runState.activeRequest = req
    }

    req.on('error', (error) => {
      if (runState?.activeRequest === req) {
        runState.activeRequest = null
      }

      if (runState?.cancelled || isAgentCancellationError(error)) {
        reject(createAgentCancellationError())
        return
      }

      reject(error)
    })
    req.setTimeout(30000, () => {
      req.destroy(new Error('Provider request timed out after 30s'))
    })

    if (runState?.cancelled) {
      req.destroy(createAgentCancellationError())
      return
    }

    req.write(body)
    req.end()
  })
}

function callOpenRouter(messages, apiKey, model, runState, onAssistantContent) {
  return callOpenAiCompatibleChat({
    hostname: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    apiKey,
    model,
    messages,
    runState,
    onAssistantContent,
    extraHeaders: {
      'HTTP-Referer': 'https://bliss.pt',
      'X-Title': 'Bliss Agent',
    },
  })
}

function callGemini(messages, apiKey, model, runState, onAssistantContent) {
  return callOpenAiCompatibleChat({
    hostname: 'generativelanguage.googleapis.com',
    path: '/v1beta/openai/chat/completions',
    apiKey,
    model,
    messages,
    runState,
    onAssistantContent,
    extraHeaders: {},
  })
}

async function callGeminiWithFallback(messages, apiKey, runState, onAssistantContent, onFallbackStatus) {
  let lastError = null
  const startIndex = getProviderModelCursor(runState?.providerCursorKey, GEMINI_MODEL_CANDIDATES.length)
  const candidateModels = rotateCandidateModels(GEMINI_MODEL_CANDIDATES, startIndex)
  const failedAttempts = []

  for (let attemptIndex = 0; attemptIndex < candidateModels.length; attemptIndex++) {
    ensureRunNotCancelled(runState)
    const candidate = candidateModels[attemptIndex]
    const { model, index } = candidate

    onFallbackStatus?.({
      provider: 'gemini',
      stage: 'trying',
      model,
      attempt: attemptIndex + 1,
      total: candidateModels.length,
    })

    try {
      const response = await callGemini(messages, apiKey, model, runState, onAssistantContent)
      const nextCursor = index === GEMINI_MODEL_CANDIDATES.length - 1 ? 0 : index
      setProviderModelCursor(runState?.providerCursorKey, nextCursor, GEMINI_MODEL_CANDIDATES.length)

      onFallbackStatus?.({
        provider: 'gemini',
        stage: 'selected',
        model,
        attempt: attemptIndex + 1,
        total: candidateModels.length,
        usedFallback: attemptIndex > 0,
      })

      return { response, model }
    } catch (error) {
      if (isAgentCancellationError(error)) throw error

      lastError = error
      const message = error.message || ''
      const statusCode = Number(error.statusCode || 0)
      const retryable = /rate limit|quota|temporarily unavailable|resource exhausted|too many requests|model not found|not found/i.test(message)
        || [404, 429, 500, 502, 503, 504].includes(statusCode)

      logMain('model attempt failed', {
        model,
        message,
        statusCode: statusCode || null,
        details: error.details || null,
      })

      failedAttempts.push({ model, statusCode: statusCode || null, message })

      onFallbackStatus?.({
        provider: 'gemini',
        stage: 'failed',
        model,
        attempt: attemptIndex + 1,
        total: candidateModels.length,
        statusCode: statusCode || null,
        message,
        retryable,
      })

      if (!retryable) {
        throw error
      }
    }
  }

  resetProviderModelCursor(runState?.providerCursorKey)

  onFallbackStatus?.({
    provider: 'gemini',
    stage: 'exhausted',
    total: candidateModels.length,
    attempts: failedAttempts,
  })

  throw createFallbackExhaustedError('Gemini AI Studio', failedAttempts, 'Gemini model chain')
}

async function callOpenRouterWithFallback(messages, apiKey, runState, onAssistantContent, onFallbackStatus) {
  let lastError = null
  const startIndex = getProviderModelCursor(runState?.providerCursorKey, OPENROUTER_MODEL_CANDIDATES.length)
  const candidateModels = rotateCandidateModels(OPENROUTER_MODEL_CANDIDATES, startIndex)
  const failedAttempts = []

  for (let attemptIndex = 0; attemptIndex < candidateModels.length; attemptIndex++) {
    ensureRunNotCancelled(runState)
    const candidate = candidateModels[attemptIndex]
    const { model, index } = candidate

    const knownAvailability = getProviderModelAvailability('openrouter', model)
    if (knownAvailability?.blocked) {
      failedAttempts.push({
        model,
        statusCode: knownAvailability.statusCode || null,
        message: knownAvailability.message || 'Skipped previously blocked model',
        skipped: true,
      })

      onFallbackStatus?.({
        provider: 'openrouter',
        stage: 'failed',
        model,
        attempt: attemptIndex + 1,
        total: candidateModels.length,
        statusCode: knownAvailability.statusCode || null,
        message: `Skipped previously unavailable model: ${knownAvailability.message || model}`,
        retryable: true,
      })
      continue
    }

    onFallbackStatus?.({
      provider: 'openrouter',
      stage: 'trying',
      model,
      attempt: attemptIndex + 1,
      total: candidateModels.length,
    })

    try {
      const response = await callOpenRouter(messages, apiKey, model, runState, onAssistantContent)
      const nextCursor = index === OPENROUTER_MODEL_CANDIDATES.length - 1 ? 0 : index
      setProviderModelCursor(runState?.providerCursorKey, nextCursor, OPENROUTER_MODEL_CANDIDATES.length)

      onFallbackStatus?.({
        provider: 'openrouter',
        stage: 'selected',
        model,
        attempt: attemptIndex + 1,
        total: candidateModels.length,
        usedFallback: attemptIndex > 0,
      })

      return { response, model }
    } catch (error) {
      if (isAgentCancellationError(error)) throw error
      lastError = error
      const {
        message,
        statusCode,
        retryable,
        permanentlyUnavailable,
        providerQuotaExhausted,
      } = classifyOpenRouterFallbackError(error)

      logMain('model attempt failed', {
        model,
        message,
        statusCode: statusCode || null,
        details: error.details || null,
      })

      failedAttempts.push({ model, statusCode: statusCode || null, message })

      if (permanentlyUnavailable) {
        blockProviderModel('openrouter', model, { statusCode: statusCode || null, message })
      }

      onFallbackStatus?.({
        provider: 'openrouter',
        stage: 'failed',
        model,
        attempt: attemptIndex + 1,
        total: candidateModels.length,
        statusCode: statusCode || null,
        message,
        retryable,
      })

      if (providerQuotaExhausted) {
        onFallbackStatus?.({
          provider: 'openrouter',
          stage: 'exhausted',
          total: candidateModels.length,
          attempts: failedAttempts,
        })

        throw createProviderQuotaExhaustedError('OpenRouter', failedAttempts, message)
      }

      if (!retryable) {
        throw error
      }
    }
  }

  resetProviderModelCursor(runState?.providerCursorKey)

  onFallbackStatus?.({
    provider: 'openrouter',
    stage: 'exhausted',
    total: candidateModels.length,
    attempts: failedAttempts,
  })

  throw createFallbackExhaustedError('OpenRouter', failedAttempts, 'OpenRouter model chain')
}

async function callProvider(messages, apiKey, provider, runState, onAssistantContent, onFallbackStatus) {
  ensureRunNotCancelled(runState)

  if (provider === 'gemini') {
    const result = await callGeminiWithFallback(messages, apiKey, runState, onAssistantContent, onFallbackStatus)
    return { ...result, provider: 'gemini' }
  }

  const result = await callOpenRouterWithFallback(messages, apiKey, runState, onAssistantContent, onFallbackStatus)
  return { ...result, provider: 'openrouter' }
}

// ─── Agentic Loop ─────────────────────────────────────────────────────────────

ipcMain.handle('agent:run', async (event, { userMessage, history, apiKey, workingDir, provider, runId }) => {
  const resolvedRunId = runId || `run-${Date.now()}`
  const resolvedProvider = provider || 'openrouter'
  const runKey = getAgentRunKey(event.sender.id, resolvedRunId)
  const providerCursorKey = getProviderCursorKey(event.sender.id, resolvedProvider)

  if (!Array.isArray(history) || history.length === 0) {
    resetProviderModelCursor(providerCursorKey)
  }

  const runState = {
    runId: resolvedRunId,
    cancelled: false,
    activeRequest: null,
    activeWorker: null,
    pendingApproval: null,
    activeToolName: '',
    toolCancellation: { requested: false, toolName: '' },
    discovery: createRunDiscoveryState(),
    providerCursorKey,
  }
  activeAgentRuns.set(runKey, runState)

  const sendUpdate = (update) => {
    try {
      const safeUpdate = toIpcSafe({ runId: resolvedRunId, ...update })
      event.sender.send('agent:update', safeUpdate)
    } catch (error) {
      logMain('Failed to send agent:update', error.message)
    }
  }
  let latestToolResult = null

  logMain('agent:run start', {
    workingDir: workingDir || process.cwd(),
    hasApiKey: Boolean(apiKey),
    provider: resolvedProvider,
    historyLength: Array.isArray(history) ? history.length : 0,
    userMessagePreview: userMessage?.slice(0, 80) || ''
  })

  const messages = [
    {
      role: 'system',
      content: `You are Bliss Agent, an expert software engineering assistant for Bliss Applications.
You have access to tools to read/write files, list directories, and run shell commands.
Prefer find_files, search_text, read_file_range, and apply_patch over broad rewrites.
After making code changes, prefer run_build, run_test, or run_lint before using raw shell commands.
Use git_status and git_diff before git_add or git_commit when preparing repository changes.
If a git tool reports that the working directory is not inside a git repository, stop and tell the user instead of probing the filesystem for .git.
When read_file or read_file_range is used, state only that the content is available via the inspector button instead of pasting raw file contents into chat. Do not mention privacy, security, policy, or data protection reasons. Summarize briefly or ask what section they want.
When changing an existing project, ground every edit in files that actually exist in the workspace.
Do not invent file names, class names, component names, page names, form names, routes, selectors, commands, or entrypoints.
Before editing, identify the relevant existing files by using find_files, search_text, read_file, or read_file_range, then base the change on what is actually present.
If the request refers to a startup flow, main screen, entrypoint, or app shell, first locate the real bootstrap and entry files for that project, then edit the concrete target instead of guessing.
If multiple plausible targets exist, inspect them briefly and choose the one that directly controls the requested behavior. If no matching file or symbol exists, say so plainly instead of assuming a default.
Working directory: ${workingDir || process.cwd()}
Be concise, precise, and always explain what you're doing before doing it.
When writing code, follow the existing patterns in the codebase.`
    },
    ...history,
    { role: 'user', content: userMessage }
  ]

  let iterations = 0
  const MAX_ITERATIONS = 20

  try {
    while (iterations < MAX_ITERATIONS) {
      iterations++
      ensureRunNotCancelled(runState)
      runState.partialAssistantText = ''
      runState.lastEmittedAssistantText = ''

      sendUpdate({ type: 'thinking', text: 'A pensar...' })
      logMain('agent iteration', iterations)

      let response
      try {
        const modelResult = await callProvider(
          messages,
          apiKey,
          provider || 'openrouter',
          runState,
          (content) => {
            sendUpdate({ type: 'assistant_partial', content })
          },
          (fallbackStatus) => {
            sendUpdate({ type: 'fallback_status', ...fallbackStatus })
          }
        )
        response = modelResult.response
        sendUpdate({ type: 'model_selected', provider: modelResult.provider, model: modelResult.model })
        logMain('using model', { provider: modelResult.provider, model: modelResult.model })
      } catch (e) {
        if (isAgentCancellationError(e)) {
          logMain('Agent run cancelled during provider call')
          return buildCancelledAgentResult(messages, runState)
        }

        logMain('Provider call failed', e.message)
        return toIpcSafe({ success: false, error: e.message })
      }

      if (response.error) {
        logMain('OpenRouter returned error payload', response.error)
        return toIpcSafe({ success: false, error: response.error.message || JSON.stringify(response.error) })
      }

      const choice = response.choices?.[0]
      if (!choice) {
        logMain('No response choices', response)
        return toIpcSafe({ success: false, error: 'No response from model' })
      }

      const message = normalizeAssistantMessage(choice.message)
      messages.push(message)
      logMain('model response', {
        finishReason: choice.finish_reason,
        hasContent: Boolean(message?.content),
        toolCallCount: message?.tool_calls?.length || 0
      })

      if (message.tool_calls && message.tool_calls.length > 0) {
        let continueAgentLoop = false

        for (const toolCall of message.tool_calls) {
          ensureRunNotCancelled(runState)

          const toolName = toolCall.function.name
          let toolArgs = {}

          try {
            toolArgs = JSON.parse(toolCall.function.arguments || '{}')
          } catch (e) {
            logMain('Invalid tool arguments', toolCall.function.arguments)
            return toIpcSafe({ success: false, error: `Invalid tool arguments for ${toolName}: ${e.message}` })
          }

          sendUpdate({ type: 'tool', tool: toolName, args: toolArgs })

          const approvalDecision = await requestToolApproval(runState, sendUpdate, workingDir || process.cwd(), toolName, toolArgs)
          if (approvalDecision.cancelled || runState.cancelled) {
            return buildCancelledAgentResult(messages, runState)
          }

          if (!approvalDecision.approved) {
            const deniedResult = {
              success: false,
              denied: true,
              error: `Approval denied for ${toolName}`,
              message: `Execution was blocked because approval was denied for ${toolName}.`,
            }

            latestToolResult = { toolName, toolArgs, result: deniedResult }
            sendUpdate({ type: 'tool_result', tool: toolName, result: deniedResult, requestId: approvalDecision.requestId })
            logMain('tool approval denied', { tool: toolName, requestId: approvalDecision.requestId })

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: buildToolResultForModel(toolName, toolArgs, deniedResult)
            })

            continueAgentLoop = true
            break
          }

          logMain('executing tool', toolName, toolArgs)

          const groundingError = ensureGroundedFileMutation(workingDir || process.cwd(), toolName, toolArgs, runState)
          if (groundingError) {
            latestToolResult = { toolName, toolArgs, result: groundingError }
            sendUpdate({ type: 'tool_result', tool: toolName, result: groundingError })
            logMain('tool blocked by grounding guard', { tool: toolName, path: toolArgs.path || null })

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: buildToolResultForModel(toolName, toolArgs, groundingError)
            })

            continueAgentLoop = true
            break
          }

          runState.activeToolName = toolName
          runState.toolCancellation = { requested: false, toolName }
          sendUpdate({ type: 'active_tool', stage: 'start', tool: toolName })

          let result
          try {
            result = await executeTool(toolName, toolArgs, workingDir, (progress) => {
              sendUpdate({ type: 'tool_progress', tool: toolName, progress })
            }, runState)
          } finally {
            sendUpdate({ type: 'active_tool', stage: 'end', tool: toolName })
            clearActiveToolExecution(runState, toolName)
          }

          latestToolResult = { toolName, toolArgs, result }

          recordToolDiscovery(runState, workingDir || process.cwd(), toolName, toolArgs, result)

          if (result.toolCancelled) {
            sendUpdate({ type: 'tool_result', tool: toolName, result })
            logMain('tool cancelled', toolName)

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: buildToolResultForModel(toolName, toolArgs, result)
            })

            continueAgentLoop = true
            break
          }

          if (result.cancelled || runState.cancelled) {
            return buildCancelledAgentResult(messages, runState)
          }

          sendUpdate({ type: 'tool_result', tool: toolName, result })
          logMain('tool result', toolName, { success: result.success })

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: buildToolResultForModel(toolName, toolArgs, result)
          })
        }

        if (continueAgentLoop) {
          continue
        }

        continue
      }

      const reply = normalizeMessageContent(message.content)

      if (reply) {
        logMain('agent:run complete', {
          replyLength: reply.length,
          replyPreview: reply.slice(0, 200),
        })
        return toIpcSafe({
          success: true,
          reply,
          messages: messages.slice(1)
        })
      }

      if (choice.finish_reason === 'stop' && latestToolResult) {
        const fallbackReply = summarizeToolResult(latestToolResult.toolName, latestToolResult.result)
        logMain('agent:run complete with tool fallback reply', {
          replyLength: fallbackReply.length,
          replyPreview: fallbackReply.slice(0, 200),
        })
        return toIpcSafe({
          success: true,
          reply: fallbackReply,
          messages: messages.slice(1)
        })
      }

      if (choice.finish_reason === 'stop') {
        logMain('Model returned empty final content')
        return toIpcSafe({ success: false, error: 'Model returned an empty response' })
      }

      break
    }

    logMain('agent loop exceeded max iterations')
    return toIpcSafe({ success: false, error: 'Max iterations reached' })
  } catch (error) {
    if (isAgentCancellationError(error)) {
      logMain('Agent run cancelled')
      return buildCancelledAgentResult(messages, runState)
    }

    throw error
  } finally {
    activeAgentRuns.delete(runKey)
  }
})

ipcMain.handle('agent:cancel', async (event, { runId } = {}) => {
  if (!runId) {
    return toIpcSafe({ success: false, error: 'runId is required' })
  }

  const runKey = getAgentRunKey(event.sender.id, runId)
  const runState = activeAgentRuns.get(runKey)
  if (!runState) {
    return toIpcSafe({ success: false, error: 'No active run found' })
  }

  cancelAgentRunState(runState)
  return toIpcSafe({ success: true, message: 'Cancellation requested.' })
})

ipcMain.handle('agent:cancel-tool', async (event, { runId } = {}) => {
  if (!runId) {
    return toIpcSafe({ success: false, error: 'runId is required' })
  }

  const runKey = getAgentRunKey(event.sender.id, runId)
  const runState = activeAgentRuns.get(runKey)
  if (!runState) {
    return toIpcSafe({ success: false, error: 'No active run found' })
  }

  if (!runState.activeToolName) {
    return toIpcSafe({ success: false, error: 'No active tool execution found' })
  }

  const toolName = runState.activeToolName
  const cancelled = cancelActiveToolExecution(runState)
  return toIpcSafe({
    success: cancelled,
    message: cancelled ? `Cancellation requested for ${toolName}.` : 'No active tool execution found',
    tool: toolName,
  })
})

ipcMain.handle('agent:approval-response', async (event, { runId, requestId, approved } = {}) => {
  if (!runId || !requestId) {
    return toIpcSafe({ success: false, error: 'runId and requestId are required' })
  }

  const runKey = getAgentRunKey(event.sender.id, runId)
  const runState = activeAgentRuns.get(runKey)
  if (!runState) {
    return toIpcSafe({ success: false, error: 'No active run found' })
  }

  if (!runState.pendingApproval || runState.pendingApproval.requestId !== requestId) {
    return toIpcSafe({ success: false, error: 'No matching approval request found' })
  }

  const pendingApproval = runState.pendingApproval
  runState.pendingApproval = null
  pendingApproval.resolve({ approved: Boolean(approved), cancelled: false, requestId })
  return toIpcSafe({ success: true, message: approved ? 'Approval granted.' : 'Approval denied.' })
})

// ─── File Picker ──────────────────────────────────────────────────────────────

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openFile'] })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('file:preview', async (_, { workingDir, path: targetPath, lineNumber }) => {
  try {
    return toIpcSafe(await readFilePreview(workingDir || process.cwd(), targetPath, lineNumber))
  } catch (error) {
    return toIpcSafe({ success: false, error: error.message })
  }
})

ipcMain.handle('github:status', async (_, { workingDir } = {}) => {
  try {
    return toIpcSafe(await getGitHubStatus(workingDir || process.cwd()))
  } catch (error) {
    return toIpcSafe({ success: false, error: error.message })
  }
})

ipcMain.handle('github:login', async (_, { workingDir } = {}) => {
  try {
    return toIpcSafe(await startGitHubLogin(workingDir || process.cwd()))
  } catch (error) {
    return toIpcSafe({ success: false, error: error.message })
  }
})
