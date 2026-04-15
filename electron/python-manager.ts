import { app } from 'electron'
import { spawn, execSync, ChildProcess } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as http from 'http'

const SERVER_PORT = 3001
const SERVER_HOST = '127.0.0.1'
const HEALTH_CHECK_URL = `http://${SERVER_HOST}:${SERVER_PORT}/status`
const MAX_WAIT_MS = 60000
const POLL_INTERVAL_MS = 500
const MAX_RESTART_ATTEMPTS = 3

export class PythonManager {
  private process: ChildProcess | null = null
  private restartCount = 0
  private intentionalStop = false
  private isExternalProcess = false

  /**
   * 启动 Python 后端
   * 如果端口已被占用且服务正常响应，复用已有进程
   */
  async start(): Promise<void> {
    // 先检测是否已有服务在运行
    const alreadyRunning = await this.checkHealth()
    if (alreadyRunning) {
      console.log('[PythonManager] Port 3001 already has a running server, reusing it')
      this.isExternalProcess = true
      return
    }

    this.intentionalStop = false
    this.spawnProcess()
  }

  private spawnProcess(): void {
    const isDev = !app.isPackaged

    let cmd: string
    let args: string[]
    let cwd: string

    // 数据目录解析（优先级从高到低）：
    // 1. 环境变量 DUNCREW_DATA_PATH
    // 2. duncrew-server.py 中的默认路径 D:\编程\DunCrew-Data（开发模式）
    // 3. 用户主目录 ~/DunCrew-Data（生产模式兜底）
    const dataPath = this.resolveDataPath(isDev)
    // 确保数据目录存在
    if (!fs.existsSync(dataPath)) {
      fs.mkdirSync(dataPath, { recursive: true })
    }

    if (isDev) {
      // 开发模式：直接运行 python
      cmd = 'python'
      args = ['duncrew-server.py', '--port', String(SERVER_PORT), '--host', SERVER_HOST, '--path', dataPath]
      cwd = path.join(__dirname, '..')
    } else {
      // 生产模式：运行 PyInstaller onedir 产物
      const exeName = process.platform === 'win32' ? 'duncrew-server.exe' : 'duncrew-server'
      const exePath = path.join(process.resourcesPath, 'duncrew-server', exeName)
      cmd = exePath
      args = ['--port', String(SERVER_PORT), '--host', SERVER_HOST, '--path', dataPath]
      cwd = path.join(process.resourcesPath, 'duncrew-server')
    }

    console.log(`[PythonManager] Starting: ${cmd} ${args.join(' ')}`)
    console.log(`[PythonManager] CWD: ${cwd}`)

    this.process = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    })

    this.process.stdout?.on('data', (data: Buffer) => {
      console.log(`[Python] ${data.toString().trim()}`)
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      console.error(`[Python:err] ${data.toString().trim()}`)
    })

    this.process.on('close', (code: number | null) => {
      console.log(`[PythonManager] Process exited with code ${code}`)
      this.process = null

      // 非预期退出且未达到重启上限，自动重启
      if (!this.intentionalStop && this.restartCount < MAX_RESTART_ATTEMPTS) {
        this.restartCount++
        console.log(`[PythonManager] Restarting (attempt ${this.restartCount}/${MAX_RESTART_ATTEMPTS})...`)
        setTimeout(() => this.spawnProcess(), 1000)
      }
    })

    this.process.on('error', (err: Error) => {
      console.error(`[PythonManager] Spawn error:`, err.message)
    })
  }

  /**
   * 等待后端就绪（轮询 /status 端点）
   */
  async waitForReady(): Promise<void> {
    const startTime = Date.now()

    while (Date.now() - startTime < MAX_WAIT_MS) {
      const ok = await this.checkHealth()
      if (ok) return
      await this.sleep(POLL_INTERVAL_MS)
    }

    throw new Error(`Python backend did not start within ${MAX_WAIT_MS / 1000}s`)
  }

  /**
   * 停止 Python 后端
   */
  stop(): void {
    this.intentionalStop = true

    // 如果是外部进程，不要杀它
    if (this.isExternalProcess) {
      console.log('[PythonManager] External process, not killing')
      return
    }

    if (!this.process || !this.process.pid) {
      return
    }

    const pid = this.process.pid
    console.log(`[PythonManager] Stopping process tree (PID: ${pid})`)

    try {
      // Windows: 用 taskkill 杀整个进程树
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' })
      } else {
        this.process.kill('SIGTERM')
        // 超时强杀
        setTimeout(() => {
          if (this.process) {
            this.process.kill('SIGKILL')
          }
        }, 3000)
      }
    } catch (err) {
      // 进程可能已经退出
      console.log('[PythonManager] Process already exited')
    }

    this.process = null
  }

  /**
   * 健康检查：GET /status
   */
  private checkHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(HEALTH_CHECK_URL, { timeout: 2000 }, (res) => {
        resolve(res.statusCode === 200)
      })
      req.on('error', () => resolve(false))
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
    })
  }

  /**
   * 解析数据目录路径
   * 优先级：环境变量 > 开发硬编码路径 > 用户主目录
   */
  private resolveDataPath(isDev: boolean): string {
    // 1. 环境变量最高优先
    const envPath = process.env.DUNCREW_DATA_PATH || process.env.DDOS_DATA_PATH
    if (envPath && fs.existsSync(envPath)) {
      console.log(`[PythonManager] Using env data path: ${envPath}`)
      return envPath
    }

    // 2. 开发模式：检查已知的开发数据目录
    if (isDev) {
      const devCandidates = [
        path.join(path.dirname(__dirname), '..', 'DunCrew-Data'),  // 项目同级目录
        'D:\\编程\\DunCrew-Data',                                    // 开发环境固定路径
      ]
      for (const candidate of devCandidates) {
        const resolved = path.resolve(candidate)
        if (fs.existsSync(resolved)) {
          console.log(`[PythonManager] Using dev data path: ${resolved}`)
          return resolved
        }
      }
    }

    // 3. 兜底：用户主目录
    const homePath = path.join(app.getPath('home'), 'DunCrew-Data')
    console.log(`[PythonManager] Using home directory path: ${homePath}`)
    return homePath
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
