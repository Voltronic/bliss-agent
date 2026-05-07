const { spawn, exec, execFile } = require('child_process')
const path = require('path')

let rendererUrl = null
let electronProcess = null
let shuttingDown = false
let viteProcess = null

const preferredPort = Number(process.env.BLISS_RENDERER_PORT || '5173')

const viteBin = process.platform === 'win32'
  ? path.join(__dirname, '..', 'node_modules', '.bin', 'vite.cmd')
  : path.join(__dirname, '..', 'node_modules', '.bin', 'vite')

const electronBin = process.platform === 'win32'
  ? path.join(__dirname, '..', 'node_modules', '.bin', 'electron.cmd')
  : path.join(__dirname, '..', 'node_modules', '.bin', 'electron')

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

function execCommand(command) {
  return new Promise((resolve) => {
    exec(command, { windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        success: !error,
        code: error?.code || 0,
        stdout: stdout || '',
        stderr: stderr || '',
      })
    })
  })
}

function execPowerShell(command) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        success: !error,
        code: error?.code || 0,
        stdout: stdout || '',
        stderr: stderr || '',
      })
    })
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function findListeningPids(port) {
  if (process.platform === 'win32') {
    const psResult = await execPowerShell(`Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`)
    if (psResult.stdout.trim()) {
      return [...new Set(
        psResult.stdout
          .split(/\r?\n/)
          .map((line) => Number(line.trim()))
          .filter((value) => Number.isInteger(value) && value > 0)
      )]
    }

    const fallbackResult = await execCommand(`netstat -ano -p tcp | findstr :${port}`)
    if (!fallbackResult.stdout.trim()) return []

    return [...new Set(
      fallbackResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /LISTENING/i.test(line))
        .map((line) => line.split(/\s+/).pop())
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )]
  }

  const result = await execCommand(`lsof -ti tcp:${port} -sTCP:LISTEN`)
  if (!result.stdout.trim()) return []

  return [...new Set(
    result.stdout
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((value) => Number.isInteger(value) && value > 0)
  )]
}

async function killPid(pid) {
  if (process.platform === 'win32') {
    await execCommand(`taskkill /PID ${pid} /T /F`)
    return
  }

  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}

async function ensurePortAvailable(port) {
  const pids = await findListeningPids(port)
  if (!pids.length) return

  console.log(`[bliss-agent] port ${port} is busy; stopping PID(s): ${pids.join(', ')}`)

  for (const pid of pids) {
    await killPid(pid)
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const remainingPids = await findListeningPids(port)
    if (!remainingPids.length) return
    await delay(200)
  }

  const remainingPids = await findListeningPids(port)
  throw new Error(`Could not free port ${port}. Remaining PID(s): ${remainingPids.join(', ')}`)
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true

  if (electronProcess && !electronProcess.killed) {
    electronProcess.kill()
  }

  if (viteProcess && !viteProcess.killed) {
    viteProcess.kill()
  }

  process.exit(code)
}

function startElectron() {
  if (electronProcess || !rendererUrl) return

  console.log(`[bliss-agent] starting Electron with ${rendererUrl}`)

  electronProcess = spawn(electronBin, ['.'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: rendererUrl,
    },
  })

  electronProcess.on('exit', (code) => {
    electronProcess = null
    if (!shuttingDown) {
      shutdown(code || 0)
    }
  })
}

function handleViteOutput(chunk, write) {
  const text = chunk.toString()
  const cleanText = stripAnsi(text)
  write(text)

  if (!rendererUrl) {
    const match = cleanText.match(/Local:\s+(http:\/\/(?:localhost|127\.0\.0\.1):\d+)/)
    if (match) {
      rendererUrl = match[1]
      console.log(`[bliss-agent] detected renderer URL: ${rendererUrl}`)
      startElectron()
    }
  }
}

async function main() {
  try {
    await ensurePortAvailable(preferredPort)
  } catch (error) {
    console.error(`[bliss-agent] ${error.message}`)
    shutdown(1)
    return
  }

  viteProcess = spawn(viteBin, ['--port', String(preferredPort), '--strictPort'], {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: process.env,
  })

  viteProcess.stdout.on('data', (chunk) => handleViteOutput(chunk, (text) => process.stdout.write(text)))
  viteProcess.stderr.on('data', (chunk) => handleViteOutput(chunk, (text) => process.stderr.write(text)))

  viteProcess.on('exit', (code) => {
    if (!shuttingDown) {
      shutdown(code || 0)
    }
  })
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

main()
