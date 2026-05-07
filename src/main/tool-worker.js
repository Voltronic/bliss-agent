const fs = require('fs')
const path = require('path')

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

function resolveToolPath(baseDir, targetPath = '.') {
  if (!targetPath) return baseDir
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(baseDir, targetPath)
}

function toRelativeToolPath(baseDir, targetPath) {
  const relativePath = path.relative(baseDir, targetPath)
  return relativePath || '.'
}

function shouldSkipWalkEntry(entryName) {
  return IGNORED_SCAN_DIRS.has(entryName)
}

async function listIgnoredDirectories(rootPath) {
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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sendMessage(type, payload) {
  if (process.send) {
    process.send({ type, payload })
  }
}

function clampNumber(value, fallback, min, max) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, numeric))
}

async function isLikelyTextFileAsync(filePath) {
  let stats
  try {
    stats = await fs.promises.stat(filePath)
  } catch {
    return false
  }

  if (stats.size > 1024 * 1024 * 2) return false

  let handle
  try {
    handle = await fs.promises.open(filePath, 'r')
    const buffer = Buffer.alloc(512)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return !buffer.subarray(0, bytesRead).includes(0)
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function walkFilesWithProgress(rootPath, maxResults, progressMessage) {
  const results = []
  const pending = [rootPath]
  let visited = 0
  let lastReportTime = 0

  while (pending.length > 0 && results.length < maxResults) {
    const currentPath = pending.pop()
    let stats

    try {
      stats = await fs.promises.stat(currentPath)
    } catch {
      continue
    }

    visited += 1

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

    const now = Date.now()
    if (visited === 1 || visited % 50 === 0 || now - lastReportTime > 250) {
      lastReportTime = now
      sendMessage('progress', {
        message: progressMessage(visited),
        visited,
      })
    }
  }

  return { results, visited }
}

async function findFilesTool(baseDir, args) {
  const searchRoot = resolveToolPath(baseDir, args.path || '.')
  const query = (args.query || '').toLowerCase()
  const maxResults = clampNumber(args.maxResults, 200, 1, 1000)

  const { results } = await walkFilesWithProgress(
    searchRoot,
    5000,
    (visited) => `Scanning files... ${visited} path(s) visited`
  )

  const files = results
    .map((filePath) => toRelativeToolPath(baseDir, filePath))
    .filter((filePath) => !query || filePath.toLowerCase().includes(query))
    .slice(0, maxResults)

  const ignoredDirectories = !query && files.length === 0
    ? await listIgnoredDirectories(searchRoot)
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
  const maxResults = clampNumber(args.maxResults, 100, 1, 500)
  const expression = args.isRegex
    ? new RegExp(args.query, args.caseSensitive ? 'g' : 'gi')
    : new RegExp(escapeRegExp(args.query), args.caseSensitive ? 'g' : 'gi')

  let targetFiles = []
  try {
    const stats = await fs.promises.stat(searchRoot)
    if (stats.isFile()) {
      targetFiles = [searchRoot]
    } else {
      const walkResult = await walkFilesWithProgress(
        searchRoot,
        5000,
        (visited) => `Preparing search... ${visited} path(s) visited`
      )
      targetFiles = walkResult.results
    }
  } catch (error) {
    return { success: false, error: error.message }
  }

  const matches = []
  let scannedFiles = 0
  let lastReportTime = 0

  for (let fileIndex = 0; fileIndex < targetFiles.length; fileIndex++) {
    const filePath = targetFiles[fileIndex]
    if (matches.length >= maxResults) break
    if (!(await isLikelyTextFileAsync(filePath))) continue

    scannedFiles += 1

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

    const now = Date.now()
    if (scannedFiles === 1 || scannedFiles % 10 === 0 || now - lastReportTime > 250) {
      lastReportTime = now
      sendMessage('progress', {
        message: `Searching text... ${scannedFiles}/${targetFiles.length} text file(s), ${matches.length} match(es)` ,
        scannedFiles,
        totalFiles: targetFiles.length,
        matches: matches.length,
      })
    }
  }

  return {
    success: true,
    matches,
    message: matches.length ? `Found ${matches.length} match(es)` : 'No matches found',
  }
}

async function runTool(toolName, baseDir, args) {
  switch (toolName) {
    case 'find_files':
      return findFilesTool(baseDir, args)
    case 'search_text':
      return searchTextTool(baseDir, args)
    default:
      return { success: false, error: `Unsupported heavy tool: ${toolName}` }
  }
}

process.on('message', async (message) => {
  if (!message || typeof message !== 'object') return

  try {
    const result = await runTool(message.toolName, message.baseDir, message.args || {})
    sendMessage('result', result)
  } catch (error) {
    sendMessage('result', { success: false, error: error.message || 'Worker execution failed' })
  }
})
