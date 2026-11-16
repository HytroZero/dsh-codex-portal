import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ExternalCliHealth } from './external-cli-contract.js'

const execFileAsync = promisify(execFile)
const PROBE_TIMEOUT_MS = 8_000

export interface SpawnSpec {
  command: string
  args: string[]
}

async function isExecutableFile(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return false
    if (platform === 'win32') return true
    await access(filePath, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function candidateNames(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return ['codex.exe', 'codex.cmd', 'codex.bat', 'codex']
  return ['codex']
}

function extraSearchDirs(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const dirs: string[] = []
  if (platform === 'win32') {
    if (env.APPDATA) dirs.push(join(env.APPDATA, 'npm'))
    if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, 'Programs', 'codex'))
  } else {
    dirs.push('/usr/local/bin', '/opt/homebrew/bin')
    if (env.HOME) dirs.push(join(env.HOME, '.npm-global', 'bin'), join(env.HOME, '.local', 'bin'))
  }
  return dirs
}

export async function resolveCodexBinary(options: {
  configuredPath?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
} = {}): Promise<string | undefined> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const configured = options.configuredPath?.trim()

  if (configured) {
    if (isAbsolute(configured) || configured.includes('/') || configured.includes('\\')) {
      return (await isExecutableFile(configured, platform)) ? configured : undefined
    }
  }

  const names = configured ? [configured] : candidateNames(platform)
  const pathEnv = env.PATH ?? env.Path ?? ''
  const searchDirs = [
    ...pathEnv.split(delimiter).map(part => part.trim()).filter(Boolean),
    ...(configured ? [] : extraSearchDirs(platform, env)),
  ]

  const seen = new Set<string>()
  for (const dir of searchDirs) {
    const normalized = platform === 'win32' ? dir.toLowerCase() : dir
    if (seen.has(normalized)) continue
    seen.add(normalized)
    for (const name of names) {
      const candidate = join(dir, name)
      if (await isExecutableFile(candidate, platform)) return candidate
    }
  }
  return undefined
}

/**
 * Resolve Windows npm `.cmd` wrappers directly to their Node entrypoint when possible,
 * avoiding `cmd.exe` quoting pitfalls; otherwise fall back to `cmd.exe /d /s /c` with an argument array.
 */
export async function buildCodexSpawnSpec(
  binaryPath: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Promise<SpawnSpec> {
  const ext = extname(binaryPath).toLowerCase()
  if (platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    try {
      const shim = await readFile(binaryPath, 'utf8')
      const match = /"%dp0%\\([^"\r\n]+\.(?:m?js|cjs))"/i.exec(shim)
      if (match?.[1]) {
        const scriptPath = resolve(dirname(binaryPath), match[1])
        if (await isExecutableFile(scriptPath, 'linux')) {
          return { command: process.execPath, args: [scriptPath, ...args] }
        }
      }
    } catch {
      // Fall back to cmd.exe wrapper below.
    }
    const comspec = process.env.ComSpec || 'cmd.exe'
    return { command: comspec, args: ['/d', '/c', binaryPath, ...args] }
  }
  return { command: binaryPath, args: [...args] }
}

async function runCodexCli(binaryPath: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> {
  const spec = await buildCodexSpawnSpec(binaryPath, args)
  try {
    const { stdout, stderr } = await execFileAsync(spec.command, spec.args, {
      env,
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    })
    return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string }
    return {
      stdout: typeof err.stdout === 'string' ? err.stdout.trim() : '',
      stderr: typeof err.stderr === 'string' ? err.stderr.trim() : (err.message ?? ''),
      code: typeof err.code === 'number' ? err.code : 1,
    }
  }
}

export async function probeCodexCliHealth(options: {
  configuredPath?: string
  env?: NodeJS.ProcessEnv
  readAccount?: (binaryPath: string) => Promise<{ authenticated: boolean; accountLabel?: string }>
} = {}): Promise<ExternalCliHealth> {
  const env = options.env ?? process.env
  const binaryPath = await resolveCodexBinary({ configuredPath: options.configuredPath, env })
  if (!binaryPath) {
    return {
      available: false,
      authenticated: false,
      errorCode: 'CLI_NOT_FOUND',
      message: options.configuredPath?.trim()
        ? `Codex CLI binary not found at "${options.configuredPath.trim()}".`
        : 'Codex CLI ("codex") was not found on PATH. Install @openai/codex or configure its binary path.',
    }
  }

  const versionResult = await runCodexCli(binaryPath, ['--version'], env)
  if (versionResult.code !== 0) {
    return {
      available: false,
      binaryPath,
      authenticated: false,
      errorCode: 'CLI_UNHEALTHY',
      message: versionResult.stderr || versionResult.stdout || 'Failed to execute codex --version',
    }
  }
  const version = (versionResult.stdout || versionResult.stderr).split(/\r?\n/)[0]?.trim() || 'unknown'

  if (options.readAccount) {
    try {
      const account = await options.readAccount(binaryPath)
      if (!account.authenticated) {
        return {
          available: true,
          binaryPath,
          version,
          authenticated: false,
          errorCode: 'CLI_NOT_AUTHENTICATED',
          message: 'Codex CLI is not authenticated. Run `codex login` in your terminal.',
        }
      }
      return {
        available: true,
        binaryPath,
        version,
        authenticated: true,
        ...(account.accountLabel ? { accountLabel: account.accountLabel } : {}),
      }
    } catch (error) {
      return {
        available: true,
        binaryPath,
        version,
        authenticated: false,
        errorCode: 'CLI_UNHEALTHY',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const loginResult = await runCodexCli(binaryPath, ['login', 'status'], env)
  const combined = [loginResult.stdout, loginResult.stderr].filter(Boolean).join(' ').trim()
  if (loginResult.code !== 0 || /not logged in|unauthenticated/i.test(combined)) {
    return {
      available: true,
      binaryPath,
      version,
      authenticated: false,
      errorCode: 'CLI_NOT_AUTHENTICATED',
      message: combined || 'Codex CLI is not authenticated. Run `codex login` in your terminal.',
    }
  }

  return {
    available: true,
    binaryPath,
    version,
    authenticated: true,
    ...(combined ? { accountLabel: combined } : {}),
  }
}
