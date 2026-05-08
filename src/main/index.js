const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { exec, execFile, spawn, fork } = require('child_process')
const https = require('https')

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
const TOOL_WORKER_PATH = path.join(__dirname, 'tool-worker.js')
const activeAgentRuns = new Map()
const chatApprovalPolicies = new Map()
const chatChangeBatches = new Map()
const repoRunSnapshots = new Map()
const providerModelCursor = new Map()
const providerModelAvailability = new Map()
const RUN_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
let runSnapshotsLoaded = false
let changeBatchesLoaded = false
let approvalPoliciesLoaded = false

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
  github_pr_review_thread_reply: { label: 'Reply to GitHub PR review thread', riskLevel: 'high' },
  github_pr_review_thread_resolve: { label: 'Resolve GitHub PR review thread', riskLevel: 'high' },
  github_pr_ready: { label: 'Change GitHub PR ready state', riskLevel: 'high' },
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

function getChatApprovalPolicyKey(senderId, chatId) {
  if (!chatId) return ''
  return `chat:${chatId}`
}

function getChatChangeBatchKey(senderId, chatId) {
  if (!chatId) return ''
  return `chat:${chatId}`
}

function normalizeApprovalPolicy(policy) {
  const allowedTools = {}

  if (policy?.allowedTools && typeof policy.allowedTools === 'object') {
    for (const [toolName, allowed] of Object.entries(policy.allowedTools)) {
      if (allowed && typeof toolName === 'string' && toolName.trim()) {
        allowedTools[toolName] = true
      }
    }
  }

  return {
    allowAll: Boolean(policy?.allowAll),
    allowedTools,
  }
}

function getApprovalPoliciesStatePath() {
  return path.join(app.getPath('userData'), 'approval-policies.json')
}

function persistApprovalPoliciesToDisk() {
  try {
    const statePath = getApprovalPoliciesStatePath()
    const payload = {
      policies: Array.from(chatApprovalPolicies.entries()).map(([key, policy]) => ({
        key,
        policy: normalizeApprovalPolicy(policy),
      })),
    }
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify(payload, null, 2), 'utf-8')
  } catch (error) {
    logMain('Failed to persist approval policies', error.message)
  }
}

function ensureApprovalPoliciesLoaded() {
  if (approvalPoliciesLoaded) return
  approvalPoliciesLoaded = true

  try {
    const statePath = getApprovalPoliciesStatePath()
    if (!fs.existsSync(statePath)) return

    const raw = fs.readFileSync(statePath, 'utf-8')
    const parsed = JSON.parse(raw)
    const policies = Array.isArray(parsed?.policies) ? parsed.policies : []

    for (const entry of policies) {
      if (!entry || typeof entry.key !== 'string' || !entry.key.trim()) continue
      const normalized = normalizeApprovalPolicy(entry.policy)
      const hasExplicitRules = normalized.allowAll || Object.keys(normalized.allowedTools).length > 0
      if (!hasExplicitRules) continue
      chatApprovalPolicies.set(entry.key.trim(), normalized)
    }
  } catch (error) {
    logMain('Failed to load approval policies', error.message)
  }
}

function shouldAutoApproveTool(policy, toolName) {
  const normalizedPolicy = normalizeApprovalPolicy(policy)
  if (!toolName) return normalizedPolicy.allowAll
  return normalizedPolicy.allowAll || Boolean(normalizedPolicy.allowedTools[toolName])
}

function buildApprovalPolicyForScope(policy, toolName, scope) {
  const normalizedPolicy = normalizeApprovalPolicy(policy)

  if (scope === 'chat') {
    return {
      allowAll: true,
      allowedTools: { ...normalizedPolicy.allowedTools },
    }
  }

  if (scope === 'tool' && toolName) {
    return {
      allowAll: normalizedPolicy.allowAll,
      allowedTools: {
        ...normalizedPolicy.allowedTools,
        [toolName]: true,
      },
    }
  }

  return normalizedPolicy
}

function getStoredChatApprovalPolicy(senderId, chatId) {
  ensureApprovalPoliciesLoaded()
  const policyKey = getChatApprovalPolicyKey(senderId, chatId)
  if (!policyKey || !chatApprovalPolicies.has(policyKey)) {
    return normalizeApprovalPolicy(null)
  }

  return normalizeApprovalPolicy(chatApprovalPolicies.get(policyKey))
}

function setStoredChatApprovalPolicy(senderId, chatId, policy) {
  ensureApprovalPoliciesLoaded()
  const policyKey = getChatApprovalPolicyKey(senderId, chatId)
  if (!policyKey) return normalizeApprovalPolicy(null)

  const normalizedPolicy = normalizeApprovalPolicy(policy)
  const hasExplicitRules = normalizedPolicy.allowAll || Object.keys(normalizedPolicy.allowedTools).length > 0

  if (hasExplicitRules) {
    chatApprovalPolicies.set(policyKey, normalizedPolicy)
  } else {
    chatApprovalPolicies.delete(policyKey)
  }

  persistApprovalPoliciesToDisk()

  return normalizedPolicy
}

function syncApprovalPolicyToActiveRuns(senderId, chatId, policy) {
  if (!chatId) return

  const normalizedPolicy = normalizeApprovalPolicy(policy)
  for (const [runKey, runState] of activeAgentRuns.entries()) {
    if (runState.chatId === chatId && runKey.startsWith(`${senderId}:`)) {
      runState.approvalPolicy = normalizedPolicy
    }
  }
}

function createEmptyChangeBatchStatus() {
  return {
    pending: false,
    fileCount: 0,
    changeCount: 0,
    addedLines: 0,
    removedLines: 0,
    changes: [],
    updatedAt: 0,
    workingDir: '',
  }
}

function createEmptyRunSnapshotStatus() {
  return {
    available: false,
    repoRoot: '',
    workingDir: '',
    refName: '',
    runId: '',
    chatId: '',
    createdAt: 0,
    changedFiles: 0,
    changedDirectories: 0,
  }
}

function buildRunSnapshotStatus(snapshot) {
  if (!snapshot?.repoRoot) {
    return createEmptyRunSnapshotStatus()
  }

  return {
    available: true,
    repoRoot: snapshot.repoRoot,
    workingDir: snapshot.baseDir || snapshot.repoRoot,
    refName: snapshot.refName || '',
    runId: snapshot.runId || '',
    chatId: snapshot.chatId || '',
    createdAt: Number(snapshot.createdAt) || 0,
    changedFiles: snapshot.files instanceof Map ? snapshot.files.size : 0,
    changedDirectories: snapshot.createdDirectories instanceof Set ? snapshot.createdDirectories.size : 0,
  }
}

function getChangeBatchesStatePath() {
  return path.join(app.getPath('userData'), 'change-batches.json')
}

function serializeChangeBatch(batch) {
  return {
    chatId: batch.chatId || '',
    baseDir: batch.baseDir || '',
    updatedAt: Number(batch.updatedAt) || 0,
    changes: batch.changes instanceof Map
      ? Array.from(batch.changes.values()).map((entry) => ({
          path: entry.path || '',
          originalContent: typeof entry.originalContent === 'string' ? entry.originalContent : '',
          currentContent: typeof entry.currentContent === 'string' ? entry.currentContent : '',
          existedBefore: Boolean(entry.existedBefore),
          existsNow: Boolean(entry.existsNow),
          addedLines: Number(entry.addedLines) || 0,
          removedLines: Number(entry.removedLines) || 0,
          diff: typeof entry.diff === 'string' ? entry.diff : '',
        }))
      : [],
  }
}

function hydrateChangeBatch(entry) {
  if (!entry || typeof entry.chatId !== 'string' || !entry.chatId.trim()) {
    return null
  }

  const changes = Array.isArray(entry.changes)
    ? entry.changes
        .filter((changeEntry) => changeEntry && typeof changeEntry.path === 'string' && changeEntry.path.trim())
        .map((changeEntry) => ({
          path: changeEntry.path.trim(),
          originalContent: typeof changeEntry.originalContent === 'string' ? changeEntry.originalContent : '',
          currentContent: typeof changeEntry.currentContent === 'string' ? changeEntry.currentContent : '',
          existedBefore: Boolean(changeEntry.existedBefore),
          existsNow: Boolean(changeEntry.existsNow),
          addedLines: Number(changeEntry.addedLines) || 0,
          removedLines: Number(changeEntry.removedLines) || 0,
          diff: typeof changeEntry.diff === 'string' ? changeEntry.diff : '',
        }))
    : []

  if (!changes.length) return null

  return {
    chatId: entry.chatId.trim(),
    baseDir: typeof entry.baseDir === 'string' ? entry.baseDir.trim() : '',
    updatedAt: Number(entry.updatedAt) || Date.now(),
    changes: new Map(changes.map((changeEntry) => [changeEntry.path, changeEntry])),
  }
}

function persistChangeBatchesToDisk() {
  try {
    const statePath = getChangeBatchesStatePath()
    const payload = {
      batches: Array.from(chatChangeBatches.values()).map((batch) => serializeChangeBatch(batch)),
    }
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify(payload, null, 2), 'utf-8')
  } catch (error) {
    logMain('Failed to persist change batches', error.message)
  }
}

function ensureChangeBatchesLoaded() {
  if (changeBatchesLoaded) return
  changeBatchesLoaded = true

  try {
    const statePath = getChangeBatchesStatePath()
    if (!fs.existsSync(statePath)) return

    const raw = fs.readFileSync(statePath, 'utf-8')
    const parsed = JSON.parse(raw)
    const batches = Array.isArray(parsed?.batches) ? parsed.batches : []

    for (const batchEntry of batches) {
      const batch = hydrateChangeBatch(batchEntry)
      if (!batch) continue
      chatChangeBatches.set(getChatChangeBatchKey('', batch.chatId), batch)
    }
  } catch (error) {
    logMain('Failed to load persisted change batches', error.message)
  }
}

function getRunSnapshotsStatePath() {
  return path.join(app.getPath('userData'), 'run-snapshots.json')
}

function serializeRunSnapshot(snapshot) {
  return {
    repoRoot: snapshot.repoRoot || '',
    baseDir: snapshot.baseDir || '',
    refName: snapshot.refName || '',
    runId: snapshot.runId || '',
    chatId: snapshot.chatId || '',
    senderId: snapshot.senderId || '',
    createdAt: Number(snapshot.createdAt) || 0,
    files: snapshot.files instanceof Map
      ? Array.from(snapshot.files.values()).map((entry) => ({
          path: entry.path || '',
          originalContent: typeof entry.originalContent === 'string' ? entry.originalContent : '',
          existedBefore: Boolean(entry.existedBefore),
        }))
      : [],
    createdDirectories: snapshot.createdDirectories instanceof Set
      ? Array.from(snapshot.createdDirectories.values())
      : [],
  }
}

function hydrateRunSnapshot(entry) {
  if (!entry || typeof entry.repoRoot !== 'string' || !entry.repoRoot.trim()) {
    return null
  }

  const files = Array.isArray(entry.files)
    ? entry.files
        .filter((fileEntry) => fileEntry && typeof fileEntry.path === 'string' && fileEntry.path.trim())
        .map((fileEntry) => ({
          path: fileEntry.path.trim(),
          originalContent: typeof fileEntry.originalContent === 'string' ? fileEntry.originalContent : '',
          existedBefore: Boolean(fileEntry.existedBefore),
        }))
    : []

  const createdDirectories = Array.isArray(entry.createdDirectories)
    ? entry.createdDirectories
        .filter((directory) => typeof directory === 'string' && directory.trim())
        .map((directory) => directory.trim())
    : []

  return {
    repoRoot: entry.repoRoot.trim(),
    baseDir: typeof entry.baseDir === 'string' && entry.baseDir.trim() ? entry.baseDir.trim() : entry.repoRoot.trim(),
    refName: typeof entry.refName === 'string' ? entry.refName.trim() : '',
    runId: typeof entry.runId === 'string' ? entry.runId : '',
    chatId: typeof entry.chatId === 'string' ? entry.chatId : '',
    senderId: Number.isFinite(Number(entry.senderId)) ? Number(entry.senderId) : (typeof entry.senderId === 'string' ? entry.senderId : ''),
    createdAt: Number(entry.createdAt) || 0,
    files: new Map(files.map((fileEntry) => [fileEntry.path, fileEntry])),
    createdDirectories: new Set(createdDirectories),
  }
}

function persistRunSnapshotsToDisk() {
  try {
    const statePath = getRunSnapshotsStatePath()
    const payload = {
      snapshots: Array.from(repoRunSnapshots.values()).map((snapshot) => serializeRunSnapshot(snapshot)),
    }

    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify(payload, null, 2), 'utf-8')
  } catch (error) {
    logMain('Failed to persist run snapshots', error.message)
  }
}

function ensureRunSnapshotsLoaded() {
  if (runSnapshotsLoaded) return
  runSnapshotsLoaded = true

  try {
    const statePath = getRunSnapshotsStatePath()
    if (!fs.existsSync(statePath)) return

    const raw = fs.readFileSync(statePath, 'utf-8')
    const parsed = JSON.parse(raw)
    const snapshots = Array.isArray(parsed?.snapshots) ? parsed.snapshots : []

    for (const snapshotEntry of snapshots) {
      const snapshot = hydrateRunSnapshot(snapshotEntry)
      if (!snapshot) continue
      repoRunSnapshots.set(snapshot.repoRoot, snapshot)
    }
  } catch (error) {
    logMain('Failed to load persisted run snapshots', error.message)
  }
}

function buildChatChangeBatchStatus(batch) {
  if (!batch?.changes?.size) {
    return createEmptyChangeBatchStatus()
  }

  const changes = Array.from(batch.changes.values())
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => ({
      path: entry.path,
      addedLines: Number(entry.addedLines) || 0,
      removedLines: Number(entry.removedLines) || 0,
      diff: entry.diff || '',
      originalContent: typeof entry.originalContent === 'string' ? entry.originalContent : '',
      currentContent: typeof entry.currentContent === 'string' ? entry.currentContent : '',
      existedBefore: Boolean(entry.existedBefore),
      existsNow: Boolean(entry.existsNow),
    }))

  const addedLines = changes.reduce((total, entry) => total + entry.addedLines, 0)
  const removedLines = changes.reduce((total, entry) => total + entry.removedLines, 0)

  return {
    pending: changes.length > 0,
    fileCount: changes.length,
    changeCount: addedLines + removedLines,
    addedLines,
    removedLines,
    changes,
    updatedAt: Number(batch.updatedAt) || Date.now(),
    workingDir: batch.baseDir || '',
  }
}

function setStoredChatChangeBatch(senderId, chatId, batch) {
  ensureChangeBatchesLoaded()
  const batchKey = getChatChangeBatchKey(senderId, chatId)
  if (!batchKey) return createEmptyChangeBatchStatus()

  const normalizedChanges = Array.isArray(batch?.changes)
    ? batch.changes
        .filter((entry) => entry && typeof entry.path === 'string' && entry.path.trim())
        .map((entry) => ({
          path: entry.path.trim(),
          originalContent: typeof entry.originalContent === 'string' ? entry.originalContent : '',
          currentContent: typeof entry.currentContent === 'string' ? entry.currentContent : '',
          existedBefore: Boolean(entry.existedBefore),
          existsNow: Boolean(entry.existsNow),
          addedLines: Number(entry.addedLines) || 0,
          removedLines: Number(entry.removedLines) || 0,
          diff: typeof entry.diff === 'string' ? entry.diff : '',
        }))
    : []

  if (!normalizedChanges.length) {
    chatChangeBatches.delete(batchKey)
    persistChangeBatchesToDisk()
    return createEmptyChangeBatchStatus()
  }

  chatChangeBatches.set(batchKey, {
    chatId,
    baseDir: typeof batch?.workingDir === 'string' && batch.workingDir.trim()
      ? batch.workingDir.trim()
      : '',
    updatedAt: Number(batch?.updatedAt) || Date.now(),
    changes: new Map(normalizedChanges.map((entry) => [entry.path, entry])),
  })

  persistChangeBatchesToDisk()

  return getStoredChatChangeBatchStatus(senderId, chatId)
}

function getStoredChatChangeBatchStatus(senderId, chatId) {
  ensureChangeBatchesLoaded()
  const batchKey = getChatChangeBatchKey(senderId, chatId)
  if (!batchKey || !chatChangeBatches.has(batchKey)) {
    return createEmptyChangeBatchStatus()
  }

  return buildChatChangeBatchStatus(chatChangeBatches.get(batchKey))
}

function clearStoredChatChangeBatch(senderId, chatId) {
  ensureChangeBatchesLoaded()
  const batchKey = getChatChangeBatchKey(senderId, chatId)
  if (!batchKey) return
  chatChangeBatches.delete(batchKey)
  persistChangeBatchesToDisk()
}

async function registerStoredChatChangeMutation(senderId, chatId, baseDir, filePath, originalContent, updatedContent, options = {}) {
  ensureChangeBatchesLoaded()
  const batchKey = getChatChangeBatchKey(senderId, chatId)
  if (!batchKey || !baseDir || !filePath) {
    return createEmptyChangeBatchStatus()
  }

  const relativePath = toRelativeToolPath(baseDir, filePath)
  const existingBatch = chatChangeBatches.get(batchKey) || {
    chatId,
    baseDir,
    changes: new Map(),
    updatedAt: Date.now(),
  }

  const previousEntry = existingBatch.changes.get(relativePath)
  const baselineContent = previousEntry ? previousEntry.originalContent : String(originalContent || '')
  const existedBefore = previousEntry
    ? previousEntry.existedBefore
    : Boolean(options.existedBefore)
  const existsNow = Object.prototype.hasOwnProperty.call(options, 'existsNow')
    ? Boolean(options.existsNow)
    : true
  const nextContent = String(updatedContent || '')
  const restoredToBaseline = existedBefore === existsNow && baselineContent === nextContent

  existingBatch.baseDir = baseDir
  existingBatch.updatedAt = Date.now()

  if (restoredToBaseline) {
    existingBatch.changes.delete(relativePath)
  } else {
    const accumulatedChange = await buildMutationChangeRecord(baseDir, filePath, baselineContent, nextContent)
    existingBatch.changes.set(relativePath, {
      path: relativePath,
      originalContent: baselineContent,
      currentContent: nextContent,
      existedBefore,
      existsNow,
      addedLines: accumulatedChange.addedLines,
      removedLines: accumulatedChange.removedLines,
      diff: accumulatedChange.diff,
    })
  }

  if (existingBatch.changes.size) {
    chatChangeBatches.set(batchKey, existingBatch)
  } else {
    chatChangeBatches.delete(batchKey)
  }

  persistChangeBatchesToDisk()

  return getStoredChatChangeBatchStatus(senderId, chatId)
}

function approveStoredChatChangeBatch(senderId, chatId) {
  ensureChangeBatchesLoaded()
  const currentBatch = getStoredChatChangeBatchStatus(senderId, chatId)
  clearStoredChatChangeBatch(senderId, chatId)

  return {
    success: true,
    approvedFiles: currentBatch.fileCount,
    batch: createEmptyChangeBatchStatus(),
  }
}

function cancelStoredChatChangeBatch(senderId, chatId) {
  ensureChangeBatchesLoaded()
  const batchKey = getChatChangeBatchKey(senderId, chatId)
  if (!batchKey || !chatChangeBatches.has(batchKey)) {
    return {
      success: true,
      revertedFiles: 0,
      batch: createEmptyChangeBatchStatus(),
    }
  }

  const batch = chatChangeBatches.get(batchKey)
  const entries = Array.from(batch.changes.values())

  for (const entry of entries) {
    const absolutePath = resolveToolPath(batch.baseDir || process.cwd(), entry.path)
    if (entry.existedBefore) {
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
      fs.writeFileSync(absolutePath, entry.originalContent, 'utf-8')
      continue
    }

    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath)
    }
  }

  clearStoredChatChangeBatch(senderId, chatId)

  return {
    success: true,
    revertedFiles: entries.length,
    batch: createEmptyChangeBatchStatus(),
  }
}

function hasActiveRunForChat(senderId, chatId) {
  if (!chatId) return false

  for (const [runKey, runState] of activeAgentRuns.entries()) {
    if (!runKey.startsWith(`${senderId}:`)) continue
    if (runState.chatId === chatId && !runState.cancelled) {
      return true
    }
  }

  return false
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
    lastReadTarget: null,
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
    const resolvedPath = resolveToolPath(baseDir, toolArgs.path)
    recordDiscoveredPath(runState, baseDir, resolvedPath, { wasRead: true })
    runState.discovery.lastReadTarget = {
      path: resolvedPath,
      displayPath: toRelativeToolPath(baseDir, resolvedPath),
      startLine: toolName === 'read_file_range'
        ? Math.max(1, Number(result?.startLine || toolArgs?.startLine || 1))
        : 1,
      endLine: toolName === 'read_file_range'
        ? Math.max(1, Number(result?.endLine || toolArgs?.endLine || 1))
        : null,
      usedRange: toolName === 'read_file_range',
    }
  }
}

function ensureGroundedFileMutation(baseDir, toolName, toolArgs, runState) {
  if (!runState?.discovery) return null
  if (!['apply_patch', 'write_file', 'delete_file', 'create_directory'].includes(toolName)) return null

  const validationFailureTarget = runState?.pendingValidationRecovery
    ? runState?.lastValidationFailure?.target || null
    : null

  if (validationFailureTarget?.path) {
    const validationTargetKey = toDiscoveryKey(baseDir, validationFailureTarget.path)
    const validationTargetWasRead = runState.discovery.readFiles.has(validationTargetKey)

    if (!validationTargetWasRead) {
      const targetRange = Number.isFinite(validationFailureTarget.startLine) && Number.isFinite(validationFailureTarget.endLine)
        ? `${validationFailureTarget.startLine}-${validationFailureTarget.endLine}`
        : null

      return {
        success: false,
        grounded: false,
        error: `${toolName} was blocked because validation recovery is active and ${validationFailureTarget.displayPath} has not been read in this run. Read ${validationFailureTarget.displayPath}${targetRange ? ` lines ${targetRange}` : ''} first, then decide on the concrete fix.`,
      }
    }
  }

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
  const normalizeText = (value) => String(value || '')
    .replace(/\{\{::[a-z0-9_:-]+\}\}/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim()

  if (typeof content === 'string') return normalizeText(content)
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part.text === 'string') return part.text
        if (part && typeof part.content === 'string') return part.content
        return ''
      })
      .join('\n')
      .replace(/\{\{::[a-z0-9_:-]+\}\}/gi, '')
      .replace(/[ \t]+\n/g, '\n')
      .trim()
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return normalizeText(content.text)
    if (typeof content.content === 'string') return normalizeText(content.content)
  }
  return ''
}

function normalizeLineEndings(text) {
  return String(text || '').replace(/\r\n/g, '\n')
}

function getPreferredLineEnding(text) {
  return String(text || '').includes('\r\n') ? '\r\n' : '\n'
}

function applyPreferredLineEndings(text, lineEnding) {
  if (lineEnding === '\r\n') {
    return String(text || '').replace(/\r?\n/g, '\r\n')
  }

  return normalizeLineEndings(text)
}

function countLiteralOccurrences(text, needle) {
  if (!needle) return 0
  return String(text || '').split(String(needle)).length - 1
}

function resolveApplyPatchUpdate(originalContent, oldText, newText, replaceAll = false) {
  const original = String(originalContent || '')
  const target = String(oldText || '')
  const replacement = String(newText || '')
  const exactOccurrences = countLiteralOccurrences(original, target)

  if (exactOccurrences > 0) {
    if (!replaceAll && exactOccurrences > 1) {
      return { success: false, error: 'oldText matched more than once; refine the patch target or set replaceAll' }
    }

    return {
      success: true,
      updated: replaceAll ? original.split(target).join(replacement) : original.replace(target, replacement),
      replacements: replaceAll ? exactOccurrences : 1,
      normalizedLineEndings: false,
    }
  }

  const normalizedOriginal = normalizeLineEndings(original)
  const normalizedTarget = normalizeLineEndings(target)
  const normalizedReplacement = normalizeLineEndings(replacement)
  const normalizedOccurrences = countLiteralOccurrences(normalizedOriginal, normalizedTarget)

  if (normalizedOccurrences === 0) {
    return { success: false, error: 'oldText was not found in the file' }
  }

  if (!replaceAll && normalizedOccurrences > 1) {
    return { success: false, error: 'oldText matched more than once; refine the patch target or set replaceAll' }
  }

  const normalizedUpdated = replaceAll
    ? normalizedOriginal.split(normalizedTarget).join(normalizedReplacement)
    : normalizedOriginal.replace(normalizedTarget, normalizedReplacement)

  return {
    success: true,
    updated: applyPreferredLineEndings(normalizedUpdated, getPreferredLineEnding(original)),
    replacements: replaceAll ? normalizedOccurrences : 1,
    normalizedLineEndings: true,
  }
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

function normalizeInlineToolCallEntries(value) {
  const entries = Array.isArray(value) ? value : [value]

  return entries
    .map((entry, index) => {
      const toolName = normalizeRequestedToolName(entry?.name || entry?.tool || entry?.function?.name)
      const rawArguments = entry?.arguments ?? entry?.args ?? entry?.function?.arguments ?? {}

      if (!toolName) return null

      return {
        id: `inline-tool-${index + 1}`,
        type: 'function',
        function: {
          name: toolName,
          arguments: JSON.stringify(normalizeInlineToolArguments(rawArguments)),
        }
      }
    })
    .filter(Boolean)
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

function isProviderTimeoutError(error) {
  const message = String(error?.message || '').toLowerCase()
  return /hard timeout|timed out after|request timed out|socket hang up|etimedout|econnreset/.test(message)
}

function classifyOpenRouterFallbackError(error) {
  const message = error?.message || ''
  const statusCode = Number(error?.statusCode || 0)
  const providerQuotaExhausted = statusCode === 429
    && /free-models-per-day|free model requests per day|add 10 credits|rate limit exceeded:\s*free/i.test(message)

  const permanentlyUnavailable = statusCode === 404
    || /model not found|not a valid model|invalid model/i.test(message)

  const retryable = providerQuotaExhausted
    || isProviderTimeoutError(error)
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
  if (!markerPattern.test(text)) {
    const rawJsonCandidate = extractBalancedJsonCandidate(text)
    if (!rawJsonCandidate) return []

    try {
      return normalizeInlineToolCallEntries(JSON.parse(rawJsonCandidate))
    } catch {
      return []
    }
  }

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
      toolCalls.push(...normalizeInlineToolCallEntries(JSON.parse(rawJson)))
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

function buildModelFileExcerpt(content, options = {}) {
  const text = typeof content === 'string' ? content : ''
  const maxLines = Math.max(1, Number(options.maxLines) || 120)
  const maxChars = Math.max(1, Number(options.maxChars) || 6000)

  if (!text) {
    return {
      excerpt: '',
      truncated: false,
      lineCount: 0,
      excerptLineCount: 0,
    }
  }

  const lines = text.split(/\r?\n/)
  const limitedLines = lines.slice(0, maxLines)
  let excerpt = limitedLines.join('\n')
  let truncated = limitedLines.length < lines.length

  if (excerpt.length > maxChars) {
    excerpt = excerpt.slice(0, maxChars)
    truncated = true
  }

  return {
    excerpt,
    truncated,
    lineCount: lines.length,
    excerptLineCount: excerpt ? excerpt.split(/\r?\n/).length : 0,
  }
}

function buildToolResultForModel(toolName, toolArgs, result) {
  if (toolName === 'read_file') {
    const content = typeof result?.content === 'string' ? result.content : ''
    const excerptInfo = buildModelFileExcerpt(content, { maxLines: 140, maxChars: 7000 })
    return JSON.stringify({
      success: Boolean(result?.success),
      path: toolArgs?.path || result?.path || '',
      totalLines: excerptInfo.lineCount,
      excerptStartLine: 1,
      excerptEndLine: excerptInfo.excerptLineCount,
      excerptTruncated: excerptInfo.truncated,
      excerpt: excerptInfo.excerpt,
      note: 'Use the excerpt for reasoning. If you need another part of the file, call read_file_range for the relevant lines. Do not paste raw file contents into the final chat reply; summarize briefly and continue the task when the request is actionable.',
    })
  }

  if (toolName === 'read_file_range') {
    const content = typeof result?.content === 'string' ? result.content : ''
    const excerptInfo = buildModelFileExcerpt(content, { maxLines: 220, maxChars: 9000 })
    return JSON.stringify({
      success: Boolean(result?.success),
      path: toolArgs?.path || result?.path || '',
      startLine: result?.startLine || toolArgs?.startLine || 1,
      endLine: result?.endLine || toolArgs?.endLine || 1,
      linesReturned: excerptInfo.lineCount,
      excerptTruncated: excerptInfo.truncated,
      excerpt: excerptInfo.excerpt,
      note: 'Use the excerpt for reasoning. Ask for another range with read_file_range only when you need additional nearby lines. Do not paste raw file contents into the final chat reply; summarize briefly and continue the task when the request is actionable.',
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
      name: 'github_issue_list',
      description: 'List and search GitHub issues for the repository associated with the selected working directory',
      parameters: {
        type: 'object',
        properties: {
          state: { type: 'string', description: 'Issue state: open, closed, or all' },
          limit: { type: 'number', description: 'Maximum number of issues to return' },
          search: { type: 'string', description: 'Optional free-text search query' },
          labels: { type: 'string', description: 'Optional comma-separated labels to filter by' },
          assignee: { type: 'string', description: 'Optional assignee filter' },
          author: { type: 'string', description: 'Optional author filter' }
        }
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
      name: 'github_pr_list',
      description: 'List and search GitHub pull requests for the repository associated with the selected working directory',
      parameters: {
        type: 'object',
        properties: {
          state: { type: 'string', description: 'Pull request state: open, closed, merged, or all' },
          limit: { type: 'number', description: 'Maximum number of pull requests to return' },
          search: { type: 'string', description: 'Optional free-text search query' },
          labels: { type: 'string', description: 'Optional comma-separated labels to filter by' },
          assignee: { type: 'string', description: 'Optional assignee filter' },
          author: { type: 'string', description: 'Optional author filter' },
          base: { type: 'string', description: 'Optional base branch filter' },
          head: { type: 'string', description: 'Optional head branch filter' },
          draft: { type: 'boolean', description: 'Optional draft-only filter when true' }
        }
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
      name: 'github_pr_checks',
      description: 'Inspect status checks and merge readiness for a GitHub pull request from the repository associated with the selected working directory',
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
      name: 'github_pr_review_threads',
      description: 'Read review threads for a GitHub pull request from the repository associated with the selected working directory',
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
          removeAssignees: { type: 'string', description: 'Optional comma-separated assignees to remove' },
          addReviewers: { type: 'string', description: 'Optional comma-separated reviewers to request' },
          removeReviewers: { type: 'string', description: 'Optional comma-separated reviewers to remove' }
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
      name: 'github_pr_review_thread_reply',
      description: 'Reply to a GitHub pull request review thread comment using the repository associated with the selected working directory',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Pull request number that owns the review thread' },
          commentId: { type: 'number', description: 'Top-level review comment ID to reply to' },
          body: { type: 'string', description: 'Reply body' }
        },
        required: ['number', 'commentId', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'github_pr_review_thread_resolve',
      description: 'Resolve or unresolve a GitHub pull request review thread for the repository associated with the selected working directory',
      parameters: {
        type: 'object',
        properties: {
          threadId: { type: 'string', description: 'GraphQL review thread ID' },
          resolved: { type: 'boolean', description: 'Whether the thread should be resolved (true) or unresolved (false)' }
        },
        required: ['threadId', 'resolved']
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
      name: 'github_pr_ready',
      description: 'Mark a GitHub pull request as ready for review or convert it back to draft in the repository associated with the selected working directory',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'number', description: 'Pull request number to update' },
          ready: { type: 'boolean', description: 'True to mark ready for review, false to convert back to draft' }
        },
        required: ['number', 'ready']
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
    case 'github_pr_review_thread_reply':
      return `Reply to PR #${toolArgs.number || '?'} review thread comment #${toolArgs.commentId || '?'}: ${truncatePreview(toolArgs.body || '', 180) || 'No reply body provided'}`
    case 'github_pr_review_thread_resolve':
      return `${toolArgs.resolved === false ? 'Unresolve' : 'Resolve'} review thread ${truncatePreview(toolArgs.threadId || '', 120) || '(missing thread id)'}`
    case 'github_pr_merge':
      return `Merge PR #${toolArgs.number || '?'} using ${toolArgs.method || 'merge'}`
    case 'github_pr_ready':
      return `${toolArgs.ready === false ? 'Convert' : 'Mark'} PR #${toolArgs.number || '?'} ${toolArgs.ready === false ? 'to draft' : 'as ready for review'}`
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

  if (shouldAutoApproveTool(runState.approvalPolicy, toolName)) {
    const decision = runState.approvalPolicy?.allowAll ? 'approved-all-chat' : 'approved-all-tool'
    sendUpdate({
      type: 'approval_auto_approved',
      requestId,
      tool: toolName,
      args: toolArgs,
      title: approvalConfig.label,
      riskLevel: approvalConfig.riskLevel,
      summary,
      decision,
    })
    return { approved: true, cancelled: false, requestId, decision }
  }

  return new Promise((resolve) => {
    runState.pendingApproval = { requestId, resolve, toolName }
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

function splitTextIntoLines(text) {
  if (!text) return []
  return String(text).split(/\r?\n/)
}

function estimateMutationLineStats(originalContent, updatedContent) {
  if (originalContent === updatedContent) {
    return { addedLines: 0, removedLines: 0 }
  }

  return {
    addedLines: splitTextIntoLines(updatedContent).length,
    removedLines: splitTextIntoLines(originalContent).length,
  }
}

function parseUnifiedDiffStats(diffText) {
  let addedLines = 0
  let removedLines = 0

  for (const line of String(diffText || '').split(/\r?\n/)) {
    if (!line) continue
    if (
      line.startsWith('diff --git ')
      || line.startsWith('index ')
      || line.startsWith('--- ')
      || line.startsWith('+++ ')
      || line.startsWith('@@ ')
      || line.startsWith('\\ No newline at end of file')
    ) {
      continue
    }

    if (line.startsWith('+')) {
      addedLines += 1
      continue
    }

    if (line.startsWith('-')) {
      removedLines += 1
    }
  }

  return { addedLines, removedLines }
}

function normalizeDiffRelativePath(targetPath) {
  const normalized = String(targetPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/')

  return normalized || 'untitled.txt'
}

async function buildUnifiedDiffText(relativePath, originalContent, updatedContent, runState) {
  if (originalContent === updatedContent) return ''

  const normalizedRelativePath = normalizeDiffRelativePath(relativePath)
  const pathSegments = normalizedRelativePath.split('/')
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bliss-agent-diff-'))
  const beforeRelativePath = ['a', ...pathSegments].join('/')
  const afterRelativePath = ['b', ...pathSegments].join('/')
  const beforeFilePath = path.join(tempDir, ...beforeRelativePath.split('/'))
  const afterFilePath = path.join(tempDir, ...afterRelativePath.split('/'))

  try {
    await fs.promises.mkdir(path.dirname(beforeFilePath), { recursive: true })
    await fs.promises.mkdir(path.dirname(afterFilePath), { recursive: true })
    await fs.promises.writeFile(beforeFilePath, originalContent, 'utf-8')
    await fs.promises.writeFile(afterFilePath, updatedContent, 'utf-8')

    const diffResult = await runExecFileCommand(
      'git',
      ['diff', '--no-index', '--no-ext-diff', '--unified=3', '--', beforeRelativePath, afterRelativePath],
      { cwd: tempDir, timeout: 30000, maxBuffer: 1024 * 1024 },
      runState,
      (error, stdout, stderr) => {
        const exitCode = typeof error?.code === 'number' ? error.code : 0
        const success = !error || exitCode === 1

        return {
          success,
          stdout: stdout || '',
          stderr: stderr || '',
          exitCode,
          error: success ? null : (stderr || stdout || error?.message || 'Git diff failed').trim(),
          missing: error?.code === 'ENOENT',
        }
      }
    )

    if (!diffResult.success || diffResult.cancelled || diffResult.missing) {
      return ''
    }

    return String(diffResult.stdout || '').trim()
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function buildMutationChangeRecord(baseDir, filePath, originalContent, updatedContent, runState) {
  const relativePath = toRelativeToolPath(baseDir, filePath)
  const diff = await buildUnifiedDiffText(relativePath, originalContent, updatedContent, runState)
  const stats = diff
    ? parseUnifiedDiffStats(diff)
    : estimateMutationLineStats(originalContent, updatedContent)

  return {
    path: relativePath,
    addedLines: stats.addedLines,
    removedLines: stats.removedLines,
    diff,
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

async function deleteRunSnapshotRef(repoRoot, refName, runState) {
  if (!repoRoot || !refName) return
  await runGitCommand(['update-ref', '-d', refName], repoRoot, runState)
}

async function pruneExpiredRunSnapshots(runState) {
  ensureRunSnapshotsLoaded()
  const now = Date.now()
  let removedAny = false
  for (const [repoRoot, snapshot] of repoRunSnapshots.entries()) {
    if (!snapshot?.createdAt || now - snapshot.createdAt < RUN_SNAPSHOT_RETENTION_MS) continue
    await deleteRunSnapshotRef(repoRoot, snapshot.refName, runState)
    repoRunSnapshots.delete(repoRoot)
    removedAny = true
  }

  if (removedAny) {
    persistRunSnapshotsToDisk()
  }
}

async function clearStoredRunSnapshot(repoRoot, runState) {
  ensureRunSnapshotsLoaded()
  if (!repoRoot || !repoRunSnapshots.has(repoRoot)) return
  const existing = repoRunSnapshots.get(repoRoot)
  await deleteRunSnapshotRef(repoRoot, existing?.refName, runState)
  repoRunSnapshots.delete(repoRoot)
  persistRunSnapshotsToDisk()
}

async function getStoredRunSnapshotStatus(baseDir, runState) {
  if (!baseDir) {
    return { success: true, snapshot: createEmptyRunSnapshotStatus() }
  }

  ensureRunSnapshotsLoaded()
  await pruneExpiredRunSnapshots(runState)

  const gitDir = await resolveGitWorkingDirectory(baseDir, runState)
  if (!gitDir.success || gitDir.cancelled) {
    return { success: true, snapshot: createEmptyRunSnapshotStatus() }
  }

  return {
    success: true,
    snapshot: buildRunSnapshotStatus(repoRunSnapshots.get(gitDir.repoRoot)),
  }
}

async function ensureRunGitSnapshot(baseDir, runState) {
  ensureRunSnapshotsLoaded()
  if (runState?.gitSnapshot?.repoRoot && repoRunSnapshots.has(runState.gitSnapshot.repoRoot)) {
    return {
      success: true,
      snapshot: repoRunSnapshots.get(runState.gitSnapshot.repoRoot),
      status: buildRunSnapshotStatus(repoRunSnapshots.get(runState.gitSnapshot.repoRoot)),
    }
  }

  const gitDir = await resolveGitWorkingDirectory(baseDir, runState)
  if (!gitDir.success || gitDir.cancelled) {
    return gitDir
  }

  await pruneExpiredRunSnapshots(runState)
  await clearStoredRunSnapshot(gitDir.repoRoot, runState)

  const headResult = await runGitCommand(['rev-parse', 'HEAD'], gitDir.repoRoot, runState)
  if (!headResult.success) {
    return {
      success: false,
      error: headResult.error || 'Failed to read git HEAD before snapshot.',
      repoRoot: gitDir.repoRoot,
    }
  }

  const createdAt = Date.now()
  const safeRunId = String(runState?.runId || createdAt).replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '') || String(createdAt)
  const refName = `refs/bliss-agent/pre-run-${createdAt}-${safeRunId}`
  const updateRefResult = await runGitCommand(['update-ref', refName, headResult.stdout.trim()], gitDir.repoRoot, runState)

  if (!updateRefResult.success) {
    return {
      success: false,
      error: updateRefResult.error || 'Failed to create git snapshot ref.',
      repoRoot: gitDir.repoRoot,
    }
  }

  const snapshot = {
    repoRoot: gitDir.repoRoot,
    baseDir: baseDir || gitDir.repoRoot,
    refName,
    runId: runState?.runId || '',
    chatId: runState?.chatId || '',
    senderId: runState?.senderId || '',
    createdAt,
    files: new Map(),
    createdDirectories: new Set(),
  }

  repoRunSnapshots.set(gitDir.repoRoot, snapshot)
  persistRunSnapshotsToDisk()

  if (runState) {
    runState.gitSnapshot = {
      repoRoot: gitDir.repoRoot,
      refName,
      createdAt,
    }
  }

  return {
    success: true,
    snapshot,
    status: buildRunSnapshotStatus(snapshot),
  }
}

async function recordRunSnapshotFileBaseline(baseDir, runState, filePath, originalContent, options = {}) {
  const ensured = await ensureRunGitSnapshot(baseDir, runState)
  if (!ensured.success) {
    return ensured
  }

  const snapshot = ensured.snapshot
  const relativePath = toRelativeToolPath(snapshot.repoRoot, filePath)

  if (!snapshot.files.has(relativePath)) {
    snapshot.files.set(relativePath, {
      path: relativePath,
      originalContent: typeof originalContent === 'string' ? originalContent : '',
      existedBefore: Boolean(options.existedBefore),
    })
    persistRunSnapshotsToDisk()
  }

  snapshot.baseDir = baseDir || snapshot.baseDir || snapshot.repoRoot

  return {
    success: true,
    snapshot,
    status: buildRunSnapshotStatus(snapshot),
  }
}

async function recordRunSnapshotDirectoryCreation(baseDir, runState, directoryPath) {
  const ensured = await ensureRunGitSnapshot(baseDir, runState)
  if (!ensured.success) {
    return ensured
  }

  const snapshot = ensured.snapshot
  snapshot.createdDirectories.add(toRelativeToolPath(snapshot.repoRoot, directoryPath))
  snapshot.baseDir = baseDir || snapshot.baseDir || snapshot.repoRoot
  persistRunSnapshotsToDisk()

  return {
    success: true,
    snapshot,
    status: buildRunSnapshotStatus(snapshot),
  }
}

async function undoStoredRunSnapshot(baseDir, runState) {
  const gitDir = await resolveGitWorkingDirectory(baseDir, runState)
  if (!gitDir.success || gitDir.cancelled) {
    return gitDir
  }

  await pruneExpiredRunSnapshots(runState)

  const snapshot = repoRunSnapshots.get(gitDir.repoRoot)
  if (!snapshot) {
    return {
      success: true,
      revertedFiles: 0,
      revertedDirectories: 0,
      snapshot: createEmptyRunSnapshotStatus(),
    }
  }

  const fileEntries = Array.from(snapshot.files.values())
  const directoryEntries = Array.from(snapshot.createdDirectories.values())
    .sort((left, right) => right.length - left.length)
  const effectiveSenderId = runState?.senderId || snapshot.senderId

  for (const entry of fileEntries) {
    const absolutePath = resolveToolPath(snapshot.repoRoot, entry.path)
    const existedBeforeUndo = fs.existsSync(absolutePath)
    const currentContent = existedBeforeUndo && fs.statSync(absolutePath).isFile()
      ? fs.readFileSync(absolutePath, 'utf-8')
      : ''

    if (entry.existedBefore) {
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
      fs.writeFileSync(absolutePath, entry.originalContent, 'utf-8')
    } else if (existedBeforeUndo) {
      fs.unlinkSync(absolutePath)
    }

    if (effectiveSenderId && snapshot.chatId) {
      await registerStoredChatChangeMutation(effectiveSenderId, snapshot.chatId, snapshot.baseDir || snapshot.repoRoot, absolutePath, currentContent, entry.existedBefore ? entry.originalContent : '', {
        existedBefore: existedBeforeUndo,
        existsNow: entry.existedBefore,
      })
    }
  }

  let revertedDirectories = 0
  for (const relativeDirectory of directoryEntries) {
    const absoluteDirectory = resolveToolPath(snapshot.repoRoot, relativeDirectory)
    if (!fs.existsSync(absoluteDirectory)) continue
    if (!fs.statSync(absoluteDirectory).isDirectory()) continue
    if (fs.readdirSync(absoluteDirectory).length > 0) continue
    fs.rmdirSync(absoluteDirectory)
    revertedDirectories += 1
  }

  await clearStoredRunSnapshot(gitDir.repoRoot, runState)

  return {
    success: true,
    revertedFiles: fileEntries.length,
    revertedDirectories,
    snapshot: createEmptyRunSnapshotStatus(),
  }
}

function runShellCommand(command, cwd, runState) {
  return runExecCommand(command, { cwd, timeout: 120000, maxBuffer: 256 * 1024 }, runState, (error, stdout, stderr) => ({
    success: !error,
    stdout: truncatePreview(stdout || '', 12000),
    stderr: truncatePreview(stderr || '', 12000),
    exitCode: error?.code || 0,
    error: error ? truncatePreview((stderr || stdout || error.message || 'Command failed').trim(), 12000) : null,
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
    validationKind: kind,
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

function parseGitHubRepoParts(repoSlug) {
  const [owner, name] = String(repoSlug || '').split('/')
  if (!owner || !name) return null
  return { owner, name }
}

function runGhGraphQl(query, variables, cwd, runState) {
  const args = ['api', 'graphql', '-f', `query=${query}`]

  for (const [key, value] of Object.entries(variables || {})) {
    if (typeof value === 'number' || typeof value === 'boolean') {
      args.push('-F', `${key}=${value}`)
    } else {
      args.push('-f', `${key}=${String(value ?? '')}`)
    }
  }

  return runGhCommand(args, cwd, runState)
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

function normalizeRequestedToolName(name) {
  const rawName = String(name || '').trim()
  if (!rawName) return ''

  return rawName
    .replace(/<[^>]*>/g, '')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
}

function stripToolArgumentCodeFence(rawArguments) {
  return String(rawArguments || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

function extractBalancedJsonCandidate(rawArguments) {
  const text = String(rawArguments || '')
  const startIndex = text.search(/[\[{]/)
  if (startIndex === -1) return ''

  const opener = text[startIndex]
  const closer = opener === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = startIndex; index < text.length; index++) {
    const char = text[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === opener) {
      depth += 1
      continue
    }

    if (char === closer) {
      depth -= 1
      if (depth === 0) {
        return text.slice(startIndex, index + 1)
      }
    }
  }

  return text.slice(startIndex).trim()
}

function repairCommonToolArgumentJsonIssues(rawArguments) {
  return String(rawArguments || '')
    .trim()
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/([{,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'(\s*:)/g, '$1"$2"$3')
    .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, '$1"$2"$3')
    .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, value) => `: ${JSON.stringify(value.replace(/\\'/g, "'"))}`)
    .replace(/:\s*([A-Za-z0-9_./\\:-]+)(?=(?:\s*(,|}|\]))|(?:\s*(?=(?:"?[A-Za-z_$][\w$-]*"?\s*:))))/g, (_, value) => {
      if (/^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/i.test(value)) {
        return `: ${value}`
      }

      return `: ${JSON.stringify(value)}`
    })
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/("(?:\\.|[^"])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[}\]])\s*(?=(?:"?[A-Za-z_$][\w$-]*"?\s*:))/g, '$1, ')
}

function shouldAttemptBasicToolArgumentRepair(rawText) {
  return Boolean(rawText) && rawText.length <= 12000
}

function shouldAttemptExpensiveToolArgumentRepair(toolName, rawText) {
  const normalizedToolName = String(toolName || '').trim()
  if (!rawText) return false
  if (rawText.length > 4000) return false
  if (normalizedToolName === 'write_file') return false
  if (/("content"\s*:|"newText"\s*:|"oldText"\s*:)/.test(rawText)) return false
  return true
}

function parseToolArguments(toolName, rawArguments) {
  const rawText = String(rawArguments || '').trim()
  if (!rawText) {
    return { success: true, args: {}, repaired: false }
  }

  const candidates = []
  const seen = new Set()

  function addCandidate(value, repaired = false) {
    const text = String(value || '').trim()
    if (!text || seen.has(text)) return
    seen.add(text)
    candidates.push({ text, repaired })
  }

  addCandidate(rawText)
  const unfenced = stripToolArgumentCodeFence(rawText)
  addCandidate(unfenced)
  addCandidate(extractBalancedJsonCandidate(unfenced))

  if (shouldAttemptBasicToolArgumentRepair(rawText)) {
    const baseCandidates = candidates.slice()
    for (const candidate of baseCandidates) {
      addCandidate(repairCommonToolArgumentJsonIssues(candidate.text), true)
    }
  }

  if (shouldAttemptExpensiveToolArgumentRepair(toolName, rawText)) {
    const baseCandidates = candidates.slice()
    for (const candidate of baseCandidates) {
      addCandidate(repairCommonToolArgumentJsonIssues(candidate.text), true)
      addCandidate(repairCommonToolArgumentJsonIssues(extractBalancedJsonCandidate(candidate.text)), true)
    }
  }

  let lastError = null
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        lastError = new Error('Tool arguments must be a JSON object')
        continue
      }

      return {
        success: true,
        args: parsed,
        repaired: candidate.repaired,
      }
    } catch (error) {
      lastError = error
    }
  }

  return {
    success: false,
    error: lastError?.message || 'Invalid JSON',
  }
}

const MUTATING_TOOL_NAMES = new Set(['apply_patch', 'write_file', 'delete_file', 'create_directory'])
const VERIFICATION_TOOL_NAMES = new Set(['read_file', 'read_file_range', 'git_diff', 'run_build', 'run_test', 'run_lint'])
const AUTO_RECOVERY_VALIDATION_TOOL_NAMES = new Set(['run_build', 'run_test', 'run_lint'])
const NON_EXECUTION_INTENT_NAMES = new Set(['read', 'explain', 'review'])
const MAX_AUTOMATIC_VALIDATION_RECOVERY_ATTEMPTS = 3
const MAX_TOOL_ENFORCEMENT_ATTEMPTS = 4
const MAX_PROVIDER_TIMEOUT_RECOVERY_ATTEMPTS = 2
const MAX_TOOL_ARGUMENT_PAYLOAD_LENGTH = 120000
const PROVIDER_REQUEST_HARD_TIMEOUT_MS = 90000

const IMPLEMENTATION_INTENT_PATTERN = /(fix|bugfix|corrig\\w*|implement\\w*|adicion\\w*|cria\\w*|altera\\w*|mud\\w*|refactor\\w*|update|transform\\w*|resolve\\w*|repair|patch|write|edit|faz\\w*|criar|atualiz\\w*|met\\w*|coloc\\w*|insir\\w*|p[õo]e\\w*|renome\\w*|remov\\w*)/i
const EXPLANATION_INTENT_PATTERN = /(explica(?:r)?|explain|porque|porqu[eê]|why|como funciona|how does|how do|o que (?:[ée]|faz)|what is|what does|mostra(?:-me)?|show me|conte[uú]do|content|review|revisa(?:r)?|analisa(?:r)?|summari[sz]e|resume|arquitetura|architecture)/i
const DIRECT_IMPLEMENTATION_REQUEST_PATTERN = /(corrig\\w*|implement\\w*|adicion\\w*|cria\\w*|altera\\w*|mud\\w*|refator\\w*|transform\\w*|resolve\\w*|repar\\w*|atualiz\\w*|faz\\w*|escrev\\w*|fix|implement|add|create|change|update|edit|patch|repair|write|met\\w*|coloc\\w*|insir\\w*|p[õo]e\\w*|renome\\w*|remov\\w*)/i
const GUIDANCE_ABOUT_IMPLEMENTATION_PATTERN = /((how (?:to|do i|can i))|como|qual a melhor forma de|what is the best way to|podes explicar como|can you explain how to)\s+(fix|implement|add|create|change|update|edit|patch|repair|resolve|corrigir|implementar|adicionar|criar|alterar|mudar|refatorar|transformar|resolver|atualizar|fazer)/i
const REVIEW_INTENT_PATTERN = /(review|revisa(?:r)?|analisa(?:r)?|audit|audita(?:r)?|feedback|avalia(?:r)?|check)/i
const READ_INTENT_PATTERN = /(mostra(?:-me)?|show me|abre|open|l[eê]|read|conte[uú]do|content|ficheiro|file|lista completa|o que j[aá] est[aá] implementado|what(?:'s| is) implemented)/i
const RUN_INTENT_PATTERN = /(run|executa(?:r)?|build|test(?:ar|e)?|lint|arranca|start|lan[çc]a|inicia)/i
const QUESTION_LIKE_PATTERN = /(\?|^\s*(como|how|porque|porqu[eê]|why|what|o que|qual|quais|onde|when)\b)/i

function classifyUserRequestIntent(text) {
  const normalized = String(text || '').trim().toLowerCase()
  if (!normalized) return 'unknown'

  if (GUIDANCE_ABOUT_IMPLEMENTATION_PATTERN.test(normalized)) return 'explain'

  const directImplementationRequest = DIRECT_IMPLEMENTATION_REQUEST_PATTERN.test(normalized)

  if (REVIEW_INTENT_PATTERN.test(normalized) && !directImplementationRequest) return 'review'
  if (READ_INTENT_PATTERN.test(normalized) && !directImplementationRequest) return 'read'
  if (RUN_INTENT_PATTERN.test(normalized) && !directImplementationRequest) return 'run'
  if (EXPLANATION_INTENT_PATTERN.test(normalized) && !directImplementationRequest) return 'explain'

  if (directImplementationRequest) return 'implement'

  if (IMPLEMENTATION_INTENT_PATTERN.test(normalized)) {
    return QUESTION_LIKE_PATTERN.test(normalized) ? 'explain' : 'implement'
  }

  if (QUESTION_LIKE_PATTERN.test(normalized)) return 'explain'
  return 'unknown'
}

function resolveRunIntent(userMessage, options = {}) {
  const interactionMode = String(options.interactionMode || '').trim().toLowerCase()
  const chatTaskMode = String(options.chatTaskMode || '').trim().toLowerCase()

  if (interactionMode === 'steer') {
    return 'implement'
  }

  if (chatTaskMode === 'implement') {
    return 'implement'
  }

  return classifyUserRequestIntent(userMessage)
}

function normalizeIterationBudget(value, fallback = 15) {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) return fallback
  return Math.max(5, Math.min(Math.round(numericValue), 60))
}

function getIterationBudgetForIntent(intent, configuredBudget = 15) {
  const budget = normalizeIterationBudget(configuredBudget, 15)

  switch (intent) {
    case 'implement':
      return budget
    case 'run':
      return budget
    case 'explain':
    case 'read':
    case 'review':
      return budget
    default:
      return budget
  }
}

function containsStandaloneCodeBlock(text) {
  return /```[\s\S]*?```/.test(String(text || ''))
}

function looksLikePlanInsteadOfAction(text) {
  const normalized = String(text || '').trim().toLowerCase()
  if (!normalized) return false

  return /(vou (corrigir|atualizar|adicionar|implementar)|vou primeiro (ver|analisar|inspecionar|verificar)|vou (ver|analisar|inspecionar|verificar) (o estado|os ficheiros|primeiro)|let me (first )?(check|inspect|review|look at)|i(?:'| wi)ll (first )?(check|inspect|review|look at)|here is the code|aqui est[áa] o c[oó]digo|para usar:|preencha as imagens|vou atualizar o projeto|os ficheiros corrigidos s[aã]o)/i.test(normalized)
}

function buildGroundingRecoveryInstruction(toolName, toolArgs, result) {
  const targetPath = String(toolArgs?.path || '').trim()
  const targetSummary = targetPath
    ? `Target path: ${targetPath}.`
    : 'Inspect the relevant concrete file or directory before mutating it.'

  return [
    `Grounding recovery required: ${toolName} was blocked because the target was not yet grounded in this run.`,
    targetSummary,
    'Do not describe the next step and do not stop.',
    'Immediately call list_directory, find_files, search_text, read_file, or read_file_range to inspect the concrete target, then retry the requested mutation and continue until the task is actually complete.',
    result?.error ? `Blocking error: ${result.error}` : '',
  ].filter(Boolean).join('\n\n')
}

function buildGroundingContinuationInstruction(failureState) {
  const targetPath = String(failureState?.toolArgs?.path || '').trim()

  return [
    'Grounding recovery is still in progress.',
    targetPath ? `You already inspected ${targetPath}. Retry the requested mutation now using the grounded file/path.` : 'You already inspected the relevant target. Retry the requested mutation now.',
    'Do not stop with a textual update, and do not just say the file is available in the inspector.',
    'Apply the change with file tools, then continue verification or finish only after the requested implementation is actually done.',
  ].join('\n\n')
}

function buildToolEnforcementRecoveryInstruction(runState) {
  const lastReadTarget = runState?.discovery?.lastReadTarget

  if (lastReadTarget?.displayPath) {
    const rangeInstruction = lastReadTarget.usedRange && lastReadTarget.endLine
      ? `You already inspected ${lastReadTarget.displayPath} lines ${lastReadTarget.startLine}-${lastReadTarget.endLine}. Continue from that concrete target now.`
      : `You already inspected ${lastReadTarget.displayPath}. Continue from that concrete target now.`

    return [
      'Tool-use correction: do not output code blocks, sample code, or hypothetical edits.',
      'This is an implementation request and must be completed with file tools.',
      rangeInstruction,
      `Apply the requested change in ${lastReadTarget.displayPath} with apply_patch or write_file, then verify briefly before finishing.`,
      'Do not stop with another textual proposal.',
    ].join('\n\n')
  }

  return [
    'Tool-use correction: do not output code blocks, sample code, or hypothetical edits.',
    'This is an implementation request. You must inspect the concrete existing file/form, apply the change with file tools, and continue until the requested behavior is actually implemented.',
    'Use find_files, search_text, read_file, or read_file_range to locate the real target first if needed, then use apply_patch or write_file, then verify briefly.',
    'Do not stop with another textual proposal.',
  ].join('\n\n')
}

function buildProviderTimeoutRecoveryInstruction(runState) {
  const lastReadTarget = runState?.discovery?.lastReadTarget

  if (lastReadTarget?.displayPath) {
    const rangeHint = lastReadTarget.usedRange && lastReadTarget.endLine
      ? `${lastReadTarget.displayPath} lines ${lastReadTarget.startLine}-${lastReadTarget.endLine}`
      : lastReadTarget.displayPath

    return [
      'The previous provider attempt timed out mid-turn.',
      `Resume immediately from the grounded target ${rangeHint}.`,
      'Do not restart analysis and do not repeat the same preamble.',
      'Either apply the next concrete file change with tools now, or if you already changed files, verify them and finish briefly.',
    ].join('\n\n')
  }

  return [
    'The previous provider attempt timed out mid-turn.',
    'Resume immediately from the current task state without restarting the analysis from scratch.',
    'Do not repeat the same preamble. Move directly to the next concrete tool step or finish only if the requested implementation is already complete.',
  ].join('\n\n')
}

function getToolCallDispatchGuardResult(toolName, rawArguments) {
  const payload = String(rawArguments || '')
  if (!payload) return null

  if (payload.length > MAX_TOOL_ARGUMENT_PAYLOAD_LENGTH) {
    return {
      success: false,
      error: `Tool arguments for ${toolName} exceed the safe main-process payload limit (${payload.length} chars).`,
      message: `The arguments for ${toolName} are too large for safe main-process dispatch. Retry with a smaller patch or a narrower file write.`,
    }
  }

  return null
}

function getIntentScopedToolGuardResult(toolName, toolArgs, runIntent, runState) {
  if (!NON_EXECUTION_INTENT_NAMES.has(runIntent)) return null
  if (runState?.successfulMutationCount > 0) return null

  let validationKind = null

  if (AUTO_RECOVERY_VALIDATION_TOOL_NAMES.has(toolName)) {
    validationKind = toolName.replace(/^run_/, '')
  } else if (toolName === 'run_command') {
    validationKind = getValidationKindFromCommand(toolArgs?.command)
  }

  if (!validationKind) return null

  return {
    success: false,
    error: `${toolName} is not appropriate for a ${runIntent} request without explicit execution intent.`,
    message: `This request is ${runIntent}-only. Do not run ${validationKind}. Use list_directory, find_files, search_text, read_file, or read_file_range unless the user explicitly asked to build, test, lint, or run the project.`,
  }
}

function getRunCommandInspectionBlockReason(command) {
  const normalized = String(command || '').trim()
  if (!normalized) return ''

  if (/^(type|cat|more)\s+/i.test(normalized)) {
    return 'Use read_file or read_file_range to inspect file contents instead of run_command.'
  }

  if (/^(get-content|gc)\s+/i.test(normalized)) {
    return 'Use read_file or read_file_range to inspect file contents instead of run_command.'
  }

  if (/^(cmd(\.exe)?\s+\/c\s+type|powershell(\.exe)?\s+-(c|command)\s+"?(get-content|type)|pwsh\s+-(c|command)\s+"?(get-content|type))\b/i.test(normalized)) {
    return 'Use read_file or read_file_range to inspect file contents instead of run_command.'
  }

  return ''
}

function shouldAutoRecoverValidationFailures(runIntent, runState) {
  return Boolean(runState?.mutationWorkflowActive || runState?.successfulMutationCount > 0)
}

function isValidationToolExecution(toolName, result) {
  return AUTO_RECOVERY_VALIDATION_TOOL_NAMES.has(toolName)
    || (toolName === 'run_command' && Boolean(result?.validationKind))
}

function isFailedValidationToolExecution(toolName, result) {
  return isValidationToolExecution(toolName, result)
    && result?.success === false
    && typeof result?.exitCode === 'number'
    && result.exitCode !== 0
}

function isSuccessfulValidationToolExecution(toolName, result) {
  return isValidationToolExecution(toolName, result) && Boolean(result?.success)
}

function getValidationFailureLog(result) {
  const parts = []

  if (result?.runner) parts.push(`Runner: ${result.runner}`)
  if (result?.command) parts.push(`Command: ${result.command}`)
  if (result?.workingDirectory) parts.push(`Working directory: ${result.workingDirectory}`)
  if (typeof result?.exitCode === 'number') parts.push(`Exit code: ${result.exitCode}`)

  const output = [result?.stderr, result?.stdout, result?.error]
    .filter((value, index, array) => typeof value === 'string' && value.trim() && array.indexOf(value) === index)
    .join('\n\n')
    .trim()

  if (output) {
    parts.push('Output:')
    parts.push(output)
  }

  return parts.join('\n').trim() || 'Validation failed without additional output.'
}

function getLastRegexMatch(pattern, text) {
  if (!(pattern instanceof RegExp) || typeof text !== 'string' || !text) return null

  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const matcher = new RegExp(pattern.source, flags)
  let match = null
  let current = matcher.exec(text)

  while (current) {
    match = current
    current = matcher.exec(text)
  }

  return match
}

function getFirstRegexMatch(pattern, text) {
  if (!(pattern instanceof RegExp) || typeof text !== 'string' || !text) return null
  const flags = pattern.flags.includes('g') ? pattern.flags.replace(/g/g, '') : pattern.flags
  const matcher = new RegExp(pattern.source, flags)
  return matcher.exec(text)
}

function normalizeValidationFailurePath(rawPath, workingDirectory) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null

  const trimmedPath = rawPath.trim().replace(/^['"(]+|['")]+$/g, '')
  const normalizedWorkingDirectory = typeof workingDirectory === 'string' && workingDirectory.trim()
    ? workingDirectory.trim()
    : ''

  const candidates = []

  if (path.isAbsolute(trimmedPath)) {
    candidates.push(path.normalize(trimmedPath))
  }

  if (normalizedWorkingDirectory) {
    candidates.push(path.resolve(normalizedWorkingDirectory, trimmedPath))
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate
      }
    } catch {
      continue
    }
  }

  return candidates[0] || trimmedPath
}

function getValidationFailureMessage(output, fallback = 'Validation failed.') {
  if (typeof output !== 'string' || !output.trim()) return fallback

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const preferredLine = lines.find((line) => /(?:error|exception|failed|traceback|typeerror|referenceerror|syntaxerror|zerodivisionerror|assertionerror)/i.test(line))
  return preferredLine || lines[0] || fallback
}

function buildValidationFailureTarget({ rawPath, lineNumber, columnNumber, message, source, workingDirectory }) {
  const resolvedPath = normalizeValidationFailurePath(rawPath, workingDirectory)
  const numericLine = Number(lineNumber)
  const numericColumn = Number(columnNumber)

  if (!resolvedPath || !Number.isFinite(numericLine) || numericLine < 1) return null

  const displayPath = normalizedWorkingDirectoryPathForDisplay(resolvedPath, workingDirectory)
  const startLine = Math.max(1, numericLine - 4)
  const endLine = numericLine + 4

  let excerpt = ''
  let excerptEndLine = endLine

  try {
    const lines = fs.readFileSync(resolvedPath, 'utf-8').split(/\r?\n/)
    excerptEndLine = Math.min(lines.length, endLine)
    excerpt = lines
      .slice(startLine - 1, excerptEndLine)
      .map((line, index) => `${startLine + index}: ${line}`)
      .join('\n')
  } catch {
    excerpt = ''
  }

  return {
    source,
    path: resolvedPath,
    displayPath,
    lineNumber: numericLine,
    columnNumber: Number.isFinite(numericColumn) ? numericColumn : null,
    message: message || 'Validation failed.',
    startLine,
    endLine: excerptEndLine,
    excerpt,
  }
}

function normalizedWorkingDirectoryPathForDisplay(targetPath, workingDirectory) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return targetPath
  if (typeof workingDirectory !== 'string' || !workingDirectory.trim()) return targetPath

  try {
    const relativePath = path.relative(workingDirectory, targetPath)
    if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
      return relativePath.split(path.sep).join('/')
    }
  } catch {
    return targetPath
  }

  return targetPath
}

function parseValidationFailureTarget(result) {
  const output = [result?.stderr, result?.stdout, result?.error]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n')

  if (!output) return null

  const workingDirectory = typeof result?.workingDirectory === 'string' && result.workingDirectory.trim()
    ? result.workingDirectory.trim()
    : ''

  const dotnetMatch = getFirstRegexMatch(/(?<path>(?:[A-Za-z]:)?[^()\r\n]+?\.(?:cs|fs|vb|xaml|razor|cshtml))\((?<line>\d+),(?<column>\d+)\):\s*(?<message>[^\r\n]+)/i, output)
  if (dotnetMatch?.groups?.path) {
    return buildValidationFailureTarget({
      rawPath: dotnetMatch.groups.path,
      lineNumber: dotnetMatch.groups.line,
      columnNumber: dotnetMatch.groups.column,
      message: dotnetMatch.groups.message,
      source: 'dotnet',
      workingDirectory,
    })
  }

  const pythonMatch = getLastRegexMatch(/File\s+"(?<path>[^"]+?\.py)",\s+line\s+(?<line>\d+)(?:,\s+in\s+[^\r\n]+)?/i, output)
  if (pythonMatch?.groups?.path) {
    return buildValidationFailureTarget({
      rawPath: pythonMatch.groups.path,
      lineNumber: pythonMatch.groups.line,
      columnNumber: null,
      message: getValidationFailureMessage(output, 'Python traceback detected.'),
      source: 'python',
      workingDirectory,
    })
  }

  const nodeStackMatch = getFirstRegexMatch(/\bat\s+(?:[^\r\n(]+\()?((?:[A-Za-z]:)?[^()\r\n]+?\.(?:[cm]?[jt]sx?|vue)):(\d+):(\d+)\)?/i, output)
  if (nodeStackMatch?.[1]) {
    return buildValidationFailureTarget({
      rawPath: nodeStackMatch[1],
      lineNumber: nodeStackMatch[2],
      columnNumber: nodeStackMatch[3],
      message: getValidationFailureMessage(output, 'Node.js stack trace detected.'),
      source: 'node',
      workingDirectory,
    })
  }

  const genericFileMatch = getFirstRegexMatch(/(?<path>(?:[A-Za-z]:)?[^:\r\n]+?\.(?:[cm]?[jt]sx?|vue|py|cs|fs|vb)):(?<line>\d+)(?::(?<column>\d+))?/i, output)
  if (genericFileMatch?.groups?.path) {
    return buildValidationFailureTarget({
      rawPath: genericFileMatch.groups.path,
      lineNumber: genericFileMatch.groups.line,
      columnNumber: genericFileMatch.groups.column,
      message: getValidationFailureMessage(output, 'Validation failure location detected.'),
      source: 'generic',
      workingDirectory,
    })
  }

  return null
}

function buildValidationRecoveryInstruction(failureState) {
  const failureLog = truncatePreview(failureState?.failureLog || '', 4000)
  const failureTarget = failureState?.target || null
  const targetSummary = failureTarget
    ? `Parsed failure target: ${failureTarget.message} at ${failureTarget.displayPath}:${failureTarget.lineNumber}${failureTarget.columnNumber ? `:${failureTarget.columnNumber}` : ''}.`
    : ''
  const targetReadInstruction = failureTarget
    ? `Start with read_file_range on ${failureTarget.displayPath} lines ${failureTarget.startLine}-${failureTarget.endLine} before deciding on the fix.`
    : ''
  const targetExcerpt = failureTarget?.excerpt
    ? `Relevant excerpt:\n\n\`\`\`text\n${truncatePreview(failureTarget.excerpt, 1600)}\n\`\`\``
    : ''
  return [
    `Automatic recovery required: ${failureState?.toolName || 'validation'} failed (${failureState?.attempts || 1}/${MAX_AUTOMATIC_VALIDATION_RECOVERY_ATTEMPTS}).`,
    'Do not stop, do not summarize the failure, and do not ask the user what to do next.',
    'Read the failing output, inspect the relevant files or ranges, fix the root cause with file tools, then rerun the same validation tool.',
    'Finish only after the validation passes or after the retry cap is reached.',
    targetSummary,
    targetReadInstruction,
    targetExcerpt,
    failureLog ? `Validation log:\n\n\`\`\`text\n${failureLog}\n\`\`\`` : ''
  ].filter(Boolean).join('\n\n')
}

function shouldEnforceToolDrivenImplementation(runIntent, reply, runState) {
  const mutationWorkflowActive = Boolean(
    runState?.mutationWorkflowActive
    || runState?.pendingGroundingRecovery
    || runState?.pendingPostWriteVerification
    || runState?.successfulMutationCount > 0
  )

  if (mutationWorkflowActive) {
    if (runState?.pendingGroundingRecovery || runState?.pendingPostWriteVerification) return true
    if (runState?.successfulMutationCount > 0 && !runState?.pendingPostWriteVerification) return false
  }

  if (runIntent !== 'implement') return false

  const text = String(reply || '').trim()
  if (!text) return false

  if (runState?.successfulMutationCount === 0) {
    return containsStandaloneCodeBlock(text) || looksLikePlanInsteadOfAction(text)
  }

  return runState?.pendingPostWriteVerification
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

async function getGitHubIssueList(baseDir, args, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 100)
  const ghArgs = [
    'issue',
    'list',
    '--limit',
    String(limit),
    '--json',
    'number,title,state,labels,assignees,author,url',
  ]

  if (typeof args?.state === 'string' && args.state.trim()) ghArgs.push('--state', args.state.trim())
  if (typeof args?.search === 'string' && args.search.trim()) ghArgs.push('--search', args.search.trim())
  for (const label of normalizeGitHubCliList(args?.labels)) ghArgs.push('--label', label)
  if (typeof args?.assignee === 'string' && args.assignee.trim()) ghArgs.push('--assignee', args.assignee.trim())
  if (typeof args?.author === 'string' && args.author.trim()) ghArgs.push('--author', args.author.trim())

  const parsed = parseGhJson(await runGhCommand(ghArgs, ready.status.repoRoot, runState))
  if (!parsed.success) return parsed

  return {
    success: true,
    issues: parsed.data,
    message: parsed.data.length ? `Loaded ${parsed.data.length} GitHub issue(s).` : 'No GitHub issues matched the current filters.',
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

async function getGitHubPullRequestList(baseDir, args, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 100)
  const ghArgs = [
    'pr',
    'list',
    '--limit',
    String(limit),
    '--json',
    'number,title,state,isDraft,reviewDecision,author,headRefName,baseRefName,url',
  ]

  if (typeof args?.state === 'string' && args.state.trim()) ghArgs.push('--state', args.state.trim())
  if (typeof args?.search === 'string' && args.search.trim()) ghArgs.push('--search', args.search.trim())
  for (const label of normalizeGitHubCliList(args?.labels)) ghArgs.push('--label', label)
  if (typeof args?.assignee === 'string' && args.assignee.trim()) ghArgs.push('--assignee', args.assignee.trim())
  if (typeof args?.author === 'string' && args.author.trim()) ghArgs.push('--author', args.author.trim())
  if (typeof args?.base === 'string' && args.base.trim()) ghArgs.push('--base', args.base.trim())
  if (typeof args?.head === 'string' && args.head.trim()) ghArgs.push('--head', args.head.trim())
  if (args?.draft === true) ghArgs.push('--draft')

  const parsed = parseGhJson(await runGhCommand(ghArgs, ready.status.repoRoot, runState))
  if (!parsed.success) return parsed

  return {
    success: true,
    pullRequests: parsed.data,
    message: parsed.data.length ? `Loaded ${parsed.data.length} GitHub pull request(s).` : 'No GitHub pull requests matched the current filters.',
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

async function getGitHubPullRequestChecks(baseDir, prNumber, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const prResponse = parseGhJson(await runGhCommand(['api', `repos/${ready.status.repoSlug}/pulls/${prNumber}`], ready.status.repoRoot, runState))
  if (!prResponse.success) return prResponse

  const headSha = prResponse.data?.head?.sha
  if (!headSha) {
    return { success: false, error: `PR #${prNumber} is missing a head SHA.` }
  }

  const statusResponse = parseGhJson(await runGhCommand(['api', `repos/${ready.status.repoSlug}/commits/${headSha}/status`], ready.status.repoRoot, runState))
  if (!statusResponse.success) return statusResponse

  const checkRunsResponse = parseGhJson(await runGhCommand([
    'api',
    `repos/${ready.status.repoSlug}/commits/${headSha}/check-runs`,
    '-H',
    'Accept: application/vnd.github+json',
  ], ready.status.repoRoot, runState))
  if (!checkRunsResponse.success) return checkRunsResponse

  const failingChecks = (checkRunsResponse.data?.check_runs || [])
    .filter((run) => ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'].includes(String(run.conclusion || '').toLowerCase()))
    .map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion, url: run.html_url }))

  return {
    success: true,
    pullRequest: {
      number: prResponse.data.number,
      title: prResponse.data.title,
      state: prResponse.data.state,
      draft: Boolean(prResponse.data.draft),
      mergeable: prResponse.data.mergeable,
      mergeableState: prResponse.data.mergeable_state || '',
      requestedReviewers: Array.isArray(prResponse.data.requested_reviewers) ? prResponse.data.requested_reviewers.map((reviewer) => reviewer?.login).filter(Boolean) : [],
      headSha,
      url: prResponse.data.html_url || '',
    },
    statusChecks: {
      state: statusResponse.data?.state || 'unknown',
      total: Array.isArray(statusResponse.data?.statuses) ? statusResponse.data.statuses.length : 0,
      statuses: statusResponse.data?.statuses || [],
    },
    checkRuns: {
      total: Number(checkRunsResponse.data?.total_count) || 0,
      runs: checkRunsResponse.data?.check_runs || [],
      failing: failingChecks,
    },
    message: failingChecks.length ? `PR #${prNumber} has ${failingChecks.length} failing check run(s).` : `Loaded merge readiness and status checks for PR #${prNumber}.`,
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

async function getGitHubPullRequestReviewThreads(baseDir, prNumber, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const repoParts = parseGitHubRepoParts(ready.status.repoSlug)
  if (!repoParts) {
    return { success: false, error: 'Unable to parse the GitHub repository owner/name.' }
  }

  const query = `query($owner:String!, $name:String!, $number:Int!) {
    repository(owner:$owner, name:$name) {
      pullRequest(number:$number) {
        reviewThreads(first:100) {
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            originalLine
            comments(first:20) {
              nodes {
                databaseId
                body
                url
                createdAt
                author {
                  login
                }
              }
            }
          }
        }
      }
    }
  }`

  const parsed = parseGhJson(await runGhGraphQl(query, { owner: repoParts.owner, name: repoParts.name, number: Number(prNumber) }, ready.status.repoRoot, runState))
  if (!parsed.success) return parsed

  const threads = parsed.data?.data?.repository?.pullRequest?.reviewThreads?.nodes || []
  return {
    success: true,
    threads,
    message: threads.length ? `Loaded ${threads.length} review thread(s) for PR #${prNumber}.` : `No review threads found for PR #${prNumber}.`,
  }
}

async function editGitHubPullRequest(baseDir, args, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const ghArgs = ['pr', 'edit', String(args.number)]
  const addReviewers = normalizeGitHubCliList(args.addReviewers)
  const removeReviewers = normalizeGitHubCliList(args.removeReviewers)

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

  if (ghArgs.length === 3 && !addReviewers.length && !removeReviewers.length) {
    return { success: false, error: 'Provide at least one PR field to edit.' }
  }

  if (ghArgs.length > 3) {
    const result = await runGhCommand(ghArgs, ready.status.repoRoot, runState)
    if (result.cancelled) return result
    if (!result.success) return result
  }

  if (addReviewers.length) {
    const addArgs = ['api', '-X', 'POST', `repos/${ready.status.repoSlug}/pulls/${args.number}/requested_reviewers`]
    for (const reviewer of addReviewers) {
      addArgs.push('-f', `reviewers[]=${reviewer}`)
    }
    const addResult = await runGhCommand(addArgs, ready.status.repoRoot, runState)
    if (addResult.cancelled) return addResult
    if (!addResult.success) return addResult
  }

  if (removeReviewers.length) {
    const removeArgs = ['api', '-X', 'DELETE', `repos/${ready.status.repoSlug}/pulls/${args.number}/requested_reviewers`]
    for (const reviewer of removeReviewers) {
      removeArgs.push('-f', `reviewers[]=${reviewer}`)
    }
    const removeResult = await runGhCommand(removeArgs, ready.status.repoRoot, runState)
    if (removeResult.cancelled) return removeResult
    if (!removeResult.success) return removeResult
  }

  return {
    success: true,
    reviewersUpdated: Boolean(addReviewers.length || removeReviewers.length),
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

async function replyToGitHubPullRequestReviewThread(baseDir, args, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const parsed = parseGhJson(await runGhCommand([
    'api',
    '-X',
    'POST',
    `repos/${ready.status.repoSlug}/pulls/${args.number}/comments/${args.commentId}/replies`,
    '-f',
    `body=${String(args.body || '').trim()}`,
  ], ready.status.repoRoot, runState))
  if (!parsed.success) return parsed

  return {
    success: true,
    reply: parsed.data,
    message: parsed.data?.html_url ? `Reply added to PR #${args.number} review thread: ${parsed.data.html_url}` : `Reply added to PR #${args.number} review thread.`,
  }
}

async function updateGitHubPullRequestReviewThreadResolution(baseDir, args, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  const mutationName = args.resolved ? 'resolveReviewThread' : 'unresolveReviewThread'
  const query = `mutation($threadId:ID!) {
    ${mutationName}(input:{threadId:$threadId}) {
      thread {
        id
        isResolved
      }
    }
  }`

  const parsed = parseGhJson(await runGhGraphQl(query, { threadId: String(args.threadId || '') }, ready.status.repoRoot, runState))
  if (!parsed.success) return parsed

  return {
    success: true,
    thread: parsed.data?.data?.[mutationName]?.thread || null,
    message: args.resolved ? 'Review thread resolved.' : 'Review thread unresolved.',
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

async function setGitHubPullRequestReadyState(baseDir, args, runState) {
  const ready = await ensureGitHubRepoReady(baseDir, runState)
  if (!ready.success) return ready

  if (args.ready !== false) {
    const result = await runGhCommand(['pr', 'ready', String(args.number)], ready.status.repoRoot, runState)
    if (result.cancelled) return result
    if (!result.success) return result

    return {
      success: true,
      stdout: result.stdout,
      message: `PR #${args.number} marked ready for review.`,
    }
  }

  const prResponse = parseGhJson(await runGhCommand(['api', `repos/${ready.status.repoSlug}/pulls/${args.number}`], ready.status.repoRoot, runState))
  if (!prResponse.success) return prResponse

  const pullRequestId = prResponse.data?.node_id
  if (!pullRequestId) {
    return { success: false, error: `PR #${args.number} is missing a node ID.` }
  }

  const query = `mutation($pullRequestId:ID!) {
    convertPullRequestToDraft(input:{pullRequestId:$pullRequestId}) {
      pullRequest {
        number
        isDraft
      }
    }
  }`

  const parsed = parseGhJson(await runGhGraphQl(query, { pullRequestId }, ready.status.repoRoot, runState))
  if (!parsed.success) return parsed

  return {
    success: true,
    pullRequest: parsed.data?.data?.convertPullRequestToDraft?.pullRequest || null,
    message: `PR #${args.number} converted to draft.`,
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
      name = normalizeRequestedToolName(name)
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
          ;(async () => {
            const filePath = resolveToolPath(baseDir, args.path)
            const original = fs.readFileSync(filePath, 'utf-8')
            await recordRunSnapshotFileBaseline(baseDir, runState, filePath, original, { existedBefore: true })

            if (!args.oldText) {
              resolve({ success: false, error: 'oldText is required for apply_patch' })
              return
            }

            const patchResolution = resolveApplyPatchUpdate(original, args.oldText, args.newText, Boolean(args.replaceAll))
            if (!patchResolution.success) {
              resolve({ success: false, error: patchResolution.error })
              return
            }

            const updated = patchResolution.updated

            fs.writeFileSync(filePath, updated, 'utf-8')
            const change = await buildMutationChangeRecord(baseDir, filePath, original, updated, runState)
            const pendingChangeBatch = await registerStoredChatChangeMutation(runState?.senderId, runState?.chatId, baseDir, filePath, original, updated, {
              existedBefore: true,
              existsNow: true,
            })

            resolve({
              success: true,
              message: `Patched ${toRelativeToolPath(baseDir, filePath)} (${patchResolution.replacements} replacement${patchResolution.replacements === 1 ? '' : 's'})${patchResolution.normalizedLineEndings ? ' with normalized line endings' : ''}`,
              replacements: patchResolution.replacements,
              path: change.path,
              changedFiles: [change],
              pendingChangeBatch,
            })
          })().catch((error) => {
            resolve({ success: false, error: error?.message || 'Failed to apply patch' })
          })
          break
        }
        case 'write_file': {
          ;(async () => {
            const filePath = resolveToolPath(baseDir, args.path)
            const existed = fs.existsSync(filePath)
            const original = existed ? fs.readFileSync(filePath, 'utf-8') : ''
            await recordRunSnapshotFileBaseline(baseDir, runState, filePath, original, { existedBefore: existed })

            fs.mkdirSync(path.dirname(filePath), { recursive: true })
            fs.writeFileSync(filePath, args.content, 'utf-8')

            const change = await buildMutationChangeRecord(baseDir, filePath, original, args.content, runState)
            const pendingChangeBatch = await registerStoredChatChangeMutation(runState?.senderId, runState?.chatId, baseDir, filePath, original, args.content, {
              existedBefore: existed,
              existsNow: true,
            })

            resolve({
              success: true,
              message: `${existed ? 'File updated' : 'File created'}: ${change.path}`,
              path: change.path,
              changedFiles: [change],
              pendingChangeBatch,
            })
          })().catch((error) => {
            resolve({ success: false, error: error?.message || 'Failed to write file' })
          })
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
          const inspectionBlockReason = getRunCommandInspectionBlockReason(args.command)
          if (inspectionBlockReason) {
            resolve({
              success: false,
              error: inspectionBlockReason,
              message: inspectionBlockReason,
              blockedCommand: args.command || '',
            })
            break
          }

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

          runExecCommand(args.command, { cwd: commandCwd, timeout: 30000, maxBuffer: 256 * 1024 }, runState, (err, stdout, stderr) => ({
            success: !err,
            stdout: truncatePreview(stdout || '', 12000),
            stderr: truncatePreview(stderr || '', 12000),
            exitCode: err?.code || 0,
            error: err ? truncatePreview((stderr || stdout || err.message || 'Command failed').trim(), 12000) : null,
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
        case 'github_issue_list': {
          getGitHubIssueList(baseDir, args, runState).then(resolve)
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
        case 'github_pr_list': {
          getGitHubPullRequestList(baseDir, args, runState).then(resolve)
          break
        }
        case 'github_pr_view': {
          getGitHubPullRequestView(baseDir, args.number, runState).then(resolve)
          break
        }
        case 'github_pr_checks': {
          getGitHubPullRequestChecks(baseDir, args.number, runState).then(resolve)
          break
        }
        case 'github_pr_review_comments': {
          getGitHubPullRequestReviewComments(baseDir, args.number, runState).then(resolve)
          break
        }
        case 'github_pr_review_threads': {
          getGitHubPullRequestReviewThreads(baseDir, args.number, runState).then(resolve)
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
        case 'github_pr_review_thread_reply': {
          replyToGitHubPullRequestReviewThread(baseDir, args, runState).then(resolve)
          break
        }
        case 'github_pr_review_thread_resolve': {
          updateGitHubPullRequestReviewThreadResolution(baseDir, args, runState).then(resolve)
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
        case 'github_pr_ready': {
          setGitHubPullRequestReadyState(baseDir, args, runState).then(resolve)
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
          ;(async () => {
            const dirPath = resolveToolPath(baseDir, args.path)
            const existed = fs.existsSync(dirPath)
            if (!existed) {
              await recordRunSnapshotDirectoryCreation(baseDir, runState, dirPath)
            }
            fs.mkdirSync(dirPath, { recursive: true })
            resolve({ success: true, message: `Directory created: ${dirPath}` })
          })().catch((error) => {
            resolve({ success: false, error: error?.message || 'Failed to create directory' })
          })
          break
        }
        case 'delete_file': {
          ;(async () => {
            const filePath = resolveToolPath(baseDir, args.path)
            const original = fs.readFileSync(filePath, 'utf-8')
            await recordRunSnapshotFileBaseline(baseDir, runState, filePath, original, { existedBefore: true })
            fs.unlinkSync(filePath)

            const change = await buildMutationChangeRecord(baseDir, filePath, original, '', runState)
            const pendingChangeBatch = await registerStoredChatChangeMutation(runState?.senderId, runState?.chatId, baseDir, filePath, original, '', {
              existedBefore: true,
              existsNow: false,
            })

            resolve({
              success: true,
              message: `File deleted: ${change.path}`,
              path: change.path,
              changedFiles: [change],
              pendingChangeBatch,
            })
          })().catch((error) => {
            resolve({ success: false, error: error?.message || 'Failed to delete file' })
          })
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

    let settled = false
    let hardTimeoutId = null
    const finalizeRequest = () => {
      if (hardTimeoutId) {
        clearTimeout(hardTimeoutId)
        hardTimeoutId = null
      }
      if (runState?.activeRequest === req) {
        runState.activeRequest = null
      }
    }
    const resolveOnce = (value) => {
      if (settled) return
      settled = true
      finalizeRequest()
      resolve(value)
    }
    const rejectOnce = (error) => {
      if (settled) return
      settled = true
      finalizeRequest()
      reject(error)
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
        if (runState?.cancelled) {
          rejectOnce(createAgentCancellationError())
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
            rejectOnce(error)
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
            rejectOnce(error)
          }
          return
        }

        if (sawSsePayload) {
          const trailingPayload = sseBuffer.trim()
          if (trailingPayload) {
            processSseEvent(trailingPayload)
          }

          resolveOnce({
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
          resolveOnce(JSON.parse(data))
        } catch (e) {
          rejectOnce(new Error(`Invalid JSON from API: ${data.slice(0, 300)}`))
        }
      })
    })

    if (runState) {
      runState.activeRequest = req
    }

    hardTimeoutId = setTimeout(() => {
      req.destroy(new Error(`Provider request exceeded ${Math.round(PROVIDER_REQUEST_HARD_TIMEOUT_MS / 1000)}s hard timeout`))
    }, PROVIDER_REQUEST_HARD_TIMEOUT_MS)

    req.on('error', (error) => {
      if (runState?.cancelled || isAgentCancellationError(error)) {
        rejectOnce(createAgentCancellationError())
        return
      }

      rejectOnce(error)
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
        || isProviderTimeoutError(error)
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

ipcMain.handle('agent:run', async (event, { userMessage, history, apiKey, workingDir, provider, runId, chatId, approvalPolicy, iterationBudget, interactionMode, chatTaskMode }) => {
  const resolvedRunId = runId || `run-${Date.now()}`
  const resolvedProvider = provider || 'openrouter'
  const runKey = getAgentRunKey(event.sender.id, resolvedRunId)
  const providerCursorKey = getProviderCursorKey(event.sender.id, resolvedProvider)
  const resolvedApprovalPolicy = chatId
    ? setStoredChatApprovalPolicy(event.sender.id, chatId, approvalPolicy || getStoredChatApprovalPolicy(event.sender.id, chatId))
    : normalizeApprovalPolicy(approvalPolicy)

  if (!Array.isArray(history) || history.length === 0) {
    resetProviderModelCursor(providerCursorKey)
  }

  const runState = {
    runId: resolvedRunId,
    senderId: event.sender.id,
    chatId: chatId || '',
    cancelled: false,
    activeRequest: null,
    activeWorker: null,
    pendingApproval: null,
    approvalPolicy: resolvedApprovalPolicy,
    activeToolName: '',
    toolCancellation: { requested: false, toolName: '' },
    discovery: createRunDiscoveryState(),
    mutationWorkflowActive: false,
    successfulMutationCount: 0,
    successfulVerificationCount: 0,
    pendingPostWriteVerification: false,
    toolEnforcementAttempts: 0,
    validationRecoveryAttempts: 0,
    pendingValidationRecovery: false,
    lastValidationFailure: null,
    pendingGroundingRecovery: false,
    lastGroundingFailure: null,
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
You are an autonomous coding agent with file system tools.
When asked to fix or implement code, follow this loop: inspect the relevant files, make the change with tools, then verify with read_file, git_diff, run_build, run_test, or run_lint before finishing when a suitable check exists.
If run_build, run_test, run_lint, or a validation-routed run_command fails with a non-zero exit code during a coding task, treat that as an expected intermediate state: read the error output, inspect the relevant code, fix the issue, and rerun validation without waiting for user input.
Do not stop after a failed validation until it passes or you have already tried to recover three times in the current run.
For read-only, explanation, review, or listing requests, do not run build, test, lint, or validation commands unless the user explicitly asked to execute them or you already made a code change that genuinely needs verification.
Never use run_command to print or inspect file contents. Use read_file, read_file_range, list_directory, or search_text for workspace inspection.
You MUST use file writing tools to implement requested code changes. Responding with code in plain text without calling write tools is a task failure.
Never explain what you would do instead of doing it.
Never return full replacement code blocks as your final response for a coding task when file tools are available.
When read_file or read_file_range is used, state only that the content is available via the inspector button instead of pasting raw file contents into chat. Do not mention privacy, security, policy, or data protection reasons. Summarize briefly and keep moving the task forward when the request is actionable. Ask what section the user wants only when they asked for explanation or you are genuinely blocked.
When changing an existing project, ground every edit in files that actually exist in the workspace.
Do not invent file names, class names, component names, page names, form names, routes, selectors, commands, or entrypoints.
Before editing, identify the relevant existing files by using find_files, search_text, read_file, or read_file_range, then base the change on what is actually present.
If the request refers to a startup flow, main screen, entrypoint, or app shell, first locate the real bootstrap and entry files for that project, then edit the concrete target instead of guessing.
If multiple plausible targets exist, inspect them briefly and choose the one that directly controls the requested behavior. If no matching file or symbol exists, say so plainly instead of assuming a default.
After you have enough context for a reasonable implementation, implement directly instead of asking for confirmation.
Do not ask how to proceed, whether to continue, or what the user prefers unless there is a genuine blocker, a missing file, or multiple incompatible interpretations that would lead to materially different implementations.
Prefer act -> show -> ask only if stuck.
Working directory: ${workingDir || process.cwd()}
Be concise, precise, and always explain what you're doing before doing it.
When writing code, follow the existing patterns in the codebase.`
    },
    ...history,
    { role: 'user', content: userMessage }
  ]

  let iterations = 0
  const runIntent = resolveRunIntent(userMessage, { interactionMode, chatTaskMode })
  const configuredIterationBudget = normalizeIterationBudget(iterationBudget, 15)
  let maxIterations = getIterationBudgetForIntent(runIntent, configuredIterationBudget)

  try {
    while (iterations < maxIterations) {
      iterations++
      ensureRunNotCancelled(runState)
      runState.partialAssistantText = ''
      runState.lastEmittedAssistantText = ''

      sendUpdate({ type: 'iteration', current: iterations, max: maxIterations, intent: runIntent })
      sendUpdate({ type: 'thinking', text: 'A pensar...' })
      logMain('agent iteration', { current: iterations, max: maxIterations, intent: runIntent })

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

        if (isProviderTimeoutError(e)) {
          runState.providerTimeoutRecoveryAttempts = Number(runState.providerTimeoutRecoveryAttempts || 0) + 1
          const partialReply = normalizeMessageContent(runState?.partialAssistantText || '')

          logMain('Provider call timed out', {
            attempts: runState.providerTimeoutRecoveryAttempts,
            hasPartialReply: Boolean(partialReply),
          })

          if (partialReply) {
            messages.push({ role: 'assistant', content: partialReply })

            if (shouldEnforceToolDrivenImplementation(runIntent, partialReply, runState)) {
              runState.toolEnforcementAttempts += 1
              if (runState.toolEnforcementAttempts >= MAX_TOOL_ENFORCEMENT_ATTEMPTS) {
                return toIpcSafe({
                  success: false,
                  error: 'The model kept timing out after replying with text/code instead of using file tools to implement the requested change.',
                })
              }

              messages.push({
                role: 'user',
                content: buildToolEnforcementRecoveryInstruction(runState),
              })
              continue
            }
          }

          if (runState.providerTimeoutRecoveryAttempts <= MAX_PROVIDER_TIMEOUT_RECOVERY_ATTEMPTS) {
            messages.push({
              role: 'user',
              content: buildProviderTimeoutRecoveryInstruction(runState),
            })
            continue
          }
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
      sendUpdate({
        type: 'model_response',
        finishReason: choice.finish_reason || 'unknown',
        hasContent: Boolean(message?.content),
        toolCallCount: message?.tool_calls?.length || 0,
      })

      if (message.tool_calls && message.tool_calls.length > 0) {
        let continueAgentLoop = false

        for (const toolCall of message.tool_calls) {
          ensureRunNotCancelled(runState)

          const toolName = normalizeRequestedToolName(toolCall.function.name)
          const rawToolArguments = toolCall.function.arguments || '{}'
          let toolArgs = {}

          const dispatchGuardResult = getToolCallDispatchGuardResult(toolName, rawToolArguments)
          if (dispatchGuardResult) {
            logMain('tool call blocked by dispatch guard', {
              toolName,
              payloadLength: String(rawToolArguments || '').length,
            })

            latestToolResult = { toolName, toolArgs: {}, result: dispatchGuardResult }
            sendUpdate({ type: 'tool', tool: toolName, args: {} })
            sendUpdate({ type: 'tool_result', tool: toolName, result: dispatchGuardResult })

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: buildToolResultForModel(toolName, {}, dispatchGuardResult)
            })

            continueAgentLoop = true
            break
          }

          const parsedToolArgs = parseToolArguments(toolName, rawToolArguments)
          if (!parsedToolArgs.success) {
            const invalidArgsResult = {
              success: false,
              error: `Invalid tool arguments for ${toolName}: ${parsedToolArgs.error}`,
              message: `The arguments for ${toolName} were not valid JSON. Retry with a strict JSON object only.`,
            }

            logMain('Invalid tool arguments', {
              toolName,
              rawArguments: toolCall.function.arguments,
              error: parsedToolArgs.error,
            })

            latestToolResult = { toolName, toolArgs: {}, result: invalidArgsResult }
            sendUpdate({ type: 'tool', tool: toolName, args: {} })
            sendUpdate({ type: 'tool_result', tool: toolName, result: invalidArgsResult })

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: buildToolResultForModel(toolName, {}, invalidArgsResult)
            })

            continueAgentLoop = true
            break
          }

          toolArgs = parsedToolArgs.args

          if (MUTATING_TOOL_NAMES.has(toolName)) {
            runState.mutationWorkflowActive = true
          }

          const intentScopedGuardResult = getIntentScopedToolGuardResult(toolName, toolArgs, runIntent, runState)
          if (intentScopedGuardResult) {
            logMain('tool call blocked by intent guard', {
              toolName,
              runIntent,
            })

            latestToolResult = { toolName, toolArgs, result: intentScopedGuardResult }
            sendUpdate({ type: 'tool', tool: toolName, args: toolArgs })
            sendUpdate({ type: 'tool_result', tool: toolName, result: intentScopedGuardResult })

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: buildToolResultForModel(toolName, toolArgs, intentScopedGuardResult)
            })

            continueAgentLoop = true
            break
          }

          const groundingError = ensureGroundedFileMutation(workingDir || process.cwd(), toolName, toolArgs, runState)
          if (groundingError) {
            latestToolResult = { toolName, toolArgs, result: groundingError }
            runState.pendingGroundingRecovery = true
            runState.lastGroundingFailure = { toolName, toolArgs, result: groundingError }
            logMain('tool blocked by grounding guard', { tool: toolName, path: toolArgs.path || null })

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: buildToolResultForModel(toolName, toolArgs, groundingError)
            })

            messages.push({
              role: 'user',
              content: buildGroundingRecoveryInstruction(toolName, toolArgs, groundingError)
            })

            continueAgentLoop = true
            break
          }

          sendUpdate({ type: 'tool', tool: toolName, args: toolArgs })

          if (MUTATING_TOOL_NAMES.has(toolName) && maxIterations < configuredIterationBudget) {
            maxIterations = configuredIterationBudget
            sendUpdate({ type: 'iteration', current: iterations, max: maxIterations, intent: runIntent })
          }

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

          if (result.success) {
            if (MUTATING_TOOL_NAMES.has(toolName)) {
              runState.successfulMutationCount += 1
              runState.pendingPostWriteVerification = true
              runState.pendingGroundingRecovery = false
              runState.lastGroundingFailure = null
            } else if (runState.pendingPostWriteVerification && VERIFICATION_TOOL_NAMES.has(toolName)) {
              runState.successfulVerificationCount += 1
              runState.pendingPostWriteVerification = false
            }

            if (isSuccessfulValidationToolExecution(toolName, result)) {
              runState.validationRecoveryAttempts = 0
              runState.pendingValidationRecovery = false
              runState.lastValidationFailure = null
            }
          }

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
          if (Object.prototype.hasOwnProperty.call(result || {}, 'pendingChangeBatch')) {
            sendUpdate({ type: 'change_batch', batch: result.pendingChangeBatch })
          }
          logMain('tool result', toolName, { success: result.success })

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: buildToolResultForModel(toolName, toolArgs, result)
          })

          if (isFailedValidationToolExecution(toolName, result) && shouldAutoRecoverValidationFailures(runIntent, runState)) {
            runState.validationRecoveryAttempts += 1
            runState.pendingValidationRecovery = true
            const validationFailureTarget = parseValidationFailureTarget(result)
            runState.lastValidationFailure = {
              toolName,
              validationKind: result.validationKind || toolName.replace(/^run_/, ''),
              attempts: runState.validationRecoveryAttempts,
              failureLog: getValidationFailureLog(result),
              target: validationFailureTarget,
            }

            if (runState.validationRecoveryAttempts >= MAX_AUTOMATIC_VALIDATION_RECOVERY_ATTEMPTS) {
              return toIpcSafe({
                success: false,
                error: `Automatic validation recovery failed after ${runState.validationRecoveryAttempts} attempts.\n\n${runState.lastValidationFailure.failureLog}`,
              })
            }

            messages.push({
              role: 'user',
              content: buildValidationRecoveryInstruction(runState.lastValidationFailure)
            })

            continueAgentLoop = true
            break
          }
        }

        if (continueAgentLoop) {
          continue
        }

        continue
      }

      const reply = normalizeMessageContent(message.content)

      if (reply) {
        if (runState.pendingValidationRecovery && runState.lastValidationFailure) {
          messages.push({
            role: 'user',
            content: buildValidationRecoveryInstruction(runState.lastValidationFailure)
          })
          continue
        }

        if (runState.pendingGroundingRecovery && runState.lastGroundingFailure) {
          messages.push({
            role: 'user',
            content: buildGroundingContinuationInstruction(runState.lastGroundingFailure)
          })
          continue
        }

        if (shouldEnforceToolDrivenImplementation(runIntent, reply, runState)) {
          runState.toolEnforcementAttempts += 1

          if (runState.toolEnforcementAttempts >= MAX_TOOL_ENFORCEMENT_ATTEMPTS) {
            return toIpcSafe({
              success: false,
              error: runState.successfulMutationCount > 0
                ? 'The model stopped after describing changes without completing a verification step. It must verify the written changes before finishing.'
                : 'The model responded with text/code instead of using file tools to implement the requested change.',
            })
          }

          messages.push({
            role: 'user',
            content: runState.successfulMutationCount > 0
              ? 'Tool-use correction: you already changed files. Do not finish yet. Verify the change with read_file, git_diff, run_build, run_test, or run_lint, then give a brief summary.'
              : buildToolEnforcementRecoveryInstruction(runState),
          })
          continue
        }

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
        const partialReply = normalizeMessageContent(runState?.partialAssistantText || '')
        if (partialReply) {
          logMain('agent:run complete with streamed partial fallback', {
            replyLength: partialReply.length,
            replyPreview: partialReply.slice(0, 200),
          })
          return toIpcSafe({
            success: true,
            reply: partialReply,
            messages: [...messages.slice(1), { role: 'assistant', content: partialReply }],
          })
        }

        logMain('Model returned empty final content with no streamed fallback')
        return toIpcSafe({ success: false, error: 'Model returned an empty response' })
      }

      if (choice.finish_reason === 'length') {
        messages.push({
          role: 'user',
          content: 'The previous response was truncated by the model. Continue from the current task state without restarting. Either call the next tool or finish briefly if the task is actually complete.',
        })
        continue
      }

      const unexpectedFinishReason = choice.finish_reason || 'unknown'
      logMain('agent loop ended with unhandled finish reason', {
        finishReason: unexpectedFinishReason,
        current: iterations,
        max: maxIterations,
      })
      return toIpcSafe({
        success: false,
        error: `Model stopped unexpectedly with finish reason "${unexpectedFinishReason}" (${iterations}/${maxIterations}).`,
      })

    }

    logMain('agent loop exceeded max iterations', { current: iterations, max: maxIterations, intent: runIntent })
    return toIpcSafe({
      success: false,
      continuationRequired: true,
      error: `Iteration budget reached (${iterations}/${maxIterations}).`,
      messages: messages.slice(1),
      currentIterations: iterations,
      maxIterations,
      continuationBudget: configuredIterationBudget,
      continuationPrompt: 'Continue the previous task from the current state until the requested work is fully complete. Use another full iteration budget and only finish once the requested outcome is actually done or a genuine blocker remains.',
    })
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

ipcMain.handle('agent:approval-response', async (event, { runId, requestId, approved, scope, chatId } = {}) => {
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

  if (approved) {
    const nextApprovalPolicy = buildApprovalPolicyForScope(runState.approvalPolicy, pendingApproval.toolName, scope)
    runState.approvalPolicy = nextApprovalPolicy

    const resolvedChatId = chatId || runState.chatId
    if (resolvedChatId) {
      setStoredChatApprovalPolicy(event.sender.id, resolvedChatId, nextApprovalPolicy)
      syncApprovalPolicyToActiveRuns(event.sender.id, resolvedChatId, nextApprovalPolicy)
    }
  }

  pendingApproval.resolve({ approved: Boolean(approved), cancelled: false, requestId })
  return toIpcSafe({ success: true, message: approved ? 'Approval granted.' : 'Approval denied.' })
})

ipcMain.handle('agent:set-approval-policy', async (event, { chatId, approvalPolicy } = {}) => {
  if (!chatId) {
    return toIpcSafe({ success: false, error: 'chatId is required' })
  }

  const normalizedPolicy = setStoredChatApprovalPolicy(event.sender.id, chatId, approvalPolicy)
  syncApprovalPolicyToActiveRuns(event.sender.id, chatId, normalizedPolicy)
  return toIpcSafe({ success: true, approvalPolicy: normalizedPolicy })
})

ipcMain.handle('change-batch:get', async (event, { chatId } = {}) => {
  if (!chatId) {
    return toIpcSafe({ success: false, error: 'chatId is required' })
  }

  return toIpcSafe({ success: true, batch: getStoredChatChangeBatchStatus(event.sender.id, chatId) })
})

ipcMain.handle('change-batch:set', async (event, { chatId, batch } = {}) => {
  if (!chatId) {
    return toIpcSafe({ success: false, error: 'chatId is required' })
  }

  return toIpcSafe({
    success: true,
    batch: setStoredChatChangeBatch(event.sender.id, chatId, batch),
  })
})

ipcMain.handle('change-batch:approve', async (event, { chatId } = {}) => {
  if (!chatId) {
    return toIpcSafe({ success: false, error: 'chatId is required' })
  }

  if (hasActiveRunForChat(event.sender.id, chatId)) {
    return toIpcSafe({ success: false, error: 'Cannot approve pending changes while this chat is still running' })
  }

  return toIpcSafe(approveStoredChatChangeBatch(event.sender.id, chatId))
})

ipcMain.handle('change-batch:cancel', async (event, { chatId } = {}) => {
  if (!chatId) {
    return toIpcSafe({ success: false, error: 'chatId is required' })
  }

  if (hasActiveRunForChat(event.sender.id, chatId)) {
    return toIpcSafe({ success: false, error: 'Cannot cancel pending changes while this chat is still running' })
  }

  try {
    return toIpcSafe(cancelStoredChatChangeBatch(event.sender.id, chatId))
  } catch (error) {
    return toIpcSafe({ success: false, error: error.message })
  }
})

ipcMain.handle('run-snapshot:get', async (_, { workingDir } = {}) => {
  try {
    return toIpcSafe(await getStoredRunSnapshotStatus(workingDir || process.cwd()))
  } catch (error) {
    return toIpcSafe({ success: false, error: error.message, snapshot: createEmptyRunSnapshotStatus() })
  }
})

ipcMain.handle('run-snapshot:undo', async (event, { workingDir } = {}) => {
  try {
    const statusResult = await getStoredRunSnapshotStatus(workingDir || process.cwd())
    const snapshot = statusResult?.snapshot

    if (snapshot?.chatId && hasActiveRunForChat(event.sender.id, snapshot.chatId)) {
      return toIpcSafe({ success: false, error: 'Cannot undo the last run while this chat is still running' })
    }

    return toIpcSafe(await undoStoredRunSnapshot(workingDir || process.cwd(), { senderId: event.sender.id }))
  } catch (error) {
    return toIpcSafe({ success: false, error: error.message, snapshot: createEmptyRunSnapshotStatus() })
  }
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
