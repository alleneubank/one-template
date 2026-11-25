#!/usr/bin/env bun

// Proves the template works: static checks, then the app on web, an iOS
// simulator, and an Android emulator, each driven the way a user would.
//
//   bun run verify                  every leg
//   bun run verify static web       only the named legs
//   bun run verify ios --without-silo
//
// The web and native legs share one dev server started with `silo up`, which
// needs a running Docker engine. --without-silo starts `one dev` directly on
// WEB_PORT (default 8081) instead, for hosts without Docker such as GitHub's
// macOS runners. Each native leg creates its own simulator or emulator and
// removes it afterwards.
// Screenshots and logs go to tmp/verify/.

import { mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, platform as hostPlatform, arch as hostArch } from 'node:os'
import { join } from 'node:path'
import { appIdentity } from '../apps/app/app.identity'

const LEGS = ['static', 'web', 'ios', 'android'] as const
type Leg = (typeof LEGS)[number]

const HOME_TEXT = 'Hello world, from One'
const NATIVE_LINK_TEXT = 'Native module demo'

const MINUTE_MS = 60_000
const STATIC_TIMEOUT_MS = 20 * MINUTE_MS
const DEV_SERVER_TIMEOUT_MS = 5 * MINUTE_MS
// Cold native builds take well over half an hour on a loaded host.
const NATIVE_BUILD_TIMEOUT_MS = 150 * MINUTE_MS
const DEVICE_BOOT_TIMEOUT_MS = 20 * MINUTE_MS
const UI_WAIT_MS = 3 * MINUTE_MS
const POLL_INTERVAL_MS = 2_000

const root = join(import.meta.dirname, '..')
const appDir = join(root, 'apps', 'app')
const outDir = join(root, 'tmp', 'verify')
const runId = `${process.pid}-${Date.now().toString(36)}`

type Cleanup = { what: string; run: () => Promise<void> }
const cleanups: Cleanup[] = []

type RunOptions = {
  cwd?: string
  env?: Record<string, string | undefined>
  timeoutMs: number
}

function log(message: string): void {
  console.log(`\n[verify] ${message}`)
}

// Runs a command with inherited output; a non-zero exit is a failed check.
async function run(cmd: readonly string[], options: RunOptions): Promise<void> {
  const proc = Bun.spawn([...cmd], {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: options.timeoutMs,
  })
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(
      `${cmd.join(' ')} exited with ${code}${proc.signalCode ? ` (${proc.signalCode})` : ''}`,
    )
  }
}

async function capture(cmd: readonly string[], options: RunOptions): Promise<string> {
  const proc = Bun.spawn([...cmd], {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: options.timeoutMs,
  })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited with ${code}`)
  return stdout
}

async function waitFor(
  what: string,
  timeoutMs: number,
  ready: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await ready())) {
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`)
    await Bun.sleep(POLL_INTERVAL_MS)
  }
}

type DevServerMode = 'silo' | 'direct'

type Options = { legs: readonly Leg[]; devServer: DevServerMode }

function parseOptions(args: readonly string[]): Options {
  const devServer: DevServerMode = args.includes('--without-silo') ? 'direct' : 'silo'
  const named = args.filter((arg) => arg !== '--without-silo')
  const unknown = named.filter((arg) => !(LEGS as readonly string[]).includes(arg))
  if (unknown.length > 0) {
    throw new Error(`unknown argument ${unknown.join(', ')}; choose legs from ${LEGS.join(', ')}`)
  }
  const legs = named.length === 0 ? LEGS : LEGS.filter((leg) => named.includes(leg))
  return { legs, devServer }
}

async function verifyStatic(): Promise<void> {
  for (const script of ['check', 'test', 'knip', 'jscpd', 'build']) {
    log(`static: bun run ${script}`)
    await run(['bun', 'run', script], { timeoutMs: STATIC_TIMEOUT_MS })
  }
}

// silo writes the ports it assigned to this worktree into .localnet.env.
function readSiloEnv(): Record<string, string> {
  const entries = readFileSync(join(root, '.localnet.env'), 'utf8')
    .split('\n')
    .map((line) => line.replace(/^export\s+/, '').trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const at = line.indexOf('=')
      return [line.slice(0, at), line.slice(at + 1).replace(/^["']|["']$/g, '')] as const
    })
  return Object.fromEntries(entries)
}

async function devServerReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/status`, {
      signal: AbortSignal.timeout(3_000),
    })
    return (await response.text()).includes('packager-status:running')
  } catch {
    return false
  }
}

// `silo up` stays in the foreground while Tilt runs, so it runs as a child
// that `silo down` stops.
async function startSiloDevServer(): Promise<number> {
  log('dev server: silo up')
  const silo = Bun.spawn(['silo', 'up'], {
    cwd: root,
    stdout: Bun.file(join(outDir, 'silo-up.log')),
    stderr: 'inherit',
  })
  cleanups.push({
    what: 'silo stack',
    run: async () => {
      await run(['silo', 'down'], { timeoutMs: 2 * MINUTE_MS })
      await run(['silo', 'down', '--clean'], { timeoutMs: 2 * MINUTE_MS })
      await silo.exited
    },
  })

  let port = 0
  await waitFor(
    'silo to assign WEB_PORT and the dev server to start',
    DEV_SERVER_TIMEOUT_MS,
    async () => {
      if (silo.exitCode !== null) throw new Error(`silo up exited with ${silo.exitCode}`)
      if (!existsSync(join(root, '.localnet.env'))) return false
      port = Number(readSiloEnv().WEB_PORT)
      return Number.isInteger(port) && port > 0 && (await devServerReady(port))
    },
  )
  log(`dev server: ready on http://localhost:${port}`)
  return port
}

// Runs `one dev` in its own process group, so cleanup stops the server and
// every process it started.
async function startDirectDevServer(): Promise<number> {
  const port = Number(process.env.WEB_PORT ?? 8081)
  log(`dev server: one dev on port ${port}`)
  const server = Bun.spawn(['bun', 'run', 'dev'], {
    cwd: appDir,
    env: { ...process.env, WEB_PORT: String(port) },
    stdio: [
      'ignore',
      Bun.file(join(outDir, 'dev-server.log')),
      Bun.file(join(outDir, 'dev-server.err.log')),
    ],
    detached: true,
  })
  cleanups.push({
    what: `dev server (process group ${server.pid})`,
    run: async () => {
      process.kill(-server.pid, 'SIGTERM')
      const exited = await Promise.race([server.exited, Bun.sleep(MINUTE_MS).then(() => null)])
      if (exited === null) process.kill(-server.pid, 'SIGKILL')
      await server.exited
    },
  })
  await waitFor(`the dev server on port ${port}`, DEV_SERVER_TIMEOUT_MS, async () => {
    if (server.exitCode !== null)
      throw new Error(`one dev exited with ${server.exitCode}; see dev-server.err.log`)
    return devServerReady(port)
  })
  log(`dev server: ready on http://localhost:${port}`)
  return port
}

async function verifyWeb(port: number): Promise<void> {
  const session = ['--session', `verify-${runId}`]
  const browser = (...args: string[]) =>
    run(['agent-browser', ...session, ...args], { timeoutMs: UI_WAIT_MS })
  cleanups.push({ what: 'browser session', run: () => browser('close') })

  log('web: home screen')
  await browser('open', `http://localhost:${port}`)
  await browser('wait', '--text', HOME_TEXT)
  await browser('screenshot', join(outDir, 'web-home.png'))

  log('web: /native')
  await browser('find', 'text', NATIVE_LINK_TEXT, 'click')
  await browser('wait', '--text', 'Hello from TypeScript')
  await browser('screenshot', join(outDir, 'web-native.png'))
}

type DeviceTarget = { platform: 'ios'; udid: string } | { platform: 'android'; serial: string }

// Every agent-device call runs against this run's own daemon state.
const agentDeviceEnv = { AGENT_DEVICE_STATE_DIR: join(outDir, 'agent-device') }

function device(target: DeviceTarget, ...args: string[]): Promise<void> {
  const selector = target.platform === 'ios' ? ['--udid', target.udid] : ['--serial', target.serial]
  return run(
    [
      'agent-device',
      ...args,
      '--platform',
      target.platform,
      ...selector,
      '--session',
      `verify-${target.platform}-${runId}`,
    ],
    { env: agentDeviceEnv, timeoutMs: UI_WAIT_MS + MINUTE_MS },
  )
}

async function proveNativeApp(target: DeviceTarget, nativeLanguage: string): Promise<void> {
  const name = target.platform
  cleanups.push({ what: `${name} agent-device session`, run: () => device(target, 'close') })
  log(`${name}: home screen`)
  await device(target, 'open', appIdentity.id, '--timeout', String(UI_WAIT_MS))
  await device(target, 'wait', 'text', HOME_TEXT, String(UI_WAIT_MS))
  await device(target, 'screenshot', join(outDir, `${name}-home.png`))

  log(`${name}: /native`)
  await device(target, 'find', 'text', NATIVE_LINK_TEXT)
  await device(target, 'wait', 'text', `Hello from ${nativeLanguage}`, String(UI_WAIT_MS))
  await device(target, 'screenshot', join(outDir, `${name}-native.png`))
}

type SimctlRuntime = {
  identifier: string
  platform: string
  version: string
  isAvailable: boolean
  supportedDeviceTypes: { identifier: string; name: string; productFamily: string }[]
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

type SimctlDeviceType = { identifier: string; name: string; minRuntimeVersionString: string }

function newest<T>(items: readonly T[], version: (item: T) => string): T | undefined {
  return items.reduce<T | undefined>(
    (best, item) =>
      best === undefined || compareVersions(version(item), version(best)) > 0 ? item : best,
    undefined,
  )
}

async function createSimulator(): Promise<string> {
  const { runtimes, devicetypes } = JSON.parse(
    await capture(['xcrun', 'simctl', 'list', '--json', 'runtimes', 'devicetypes'], {
      timeoutMs: MINUTE_MS,
    }),
  ) as { runtimes: SimctlRuntime[]; devicetypes: SimctlDeviceType[] }
  const runtime = newest(
    runtimes.filter((candidate) => candidate.platform === 'iOS' && candidate.isAvailable),
    (candidate) => candidate.version,
  )
  if (!runtime) throw new Error('no iOS simulator runtime is installed; install one in Xcode')
  // The newest iPhone this runtime supports: the one with the highest minimum runtime.
  const supported = new Set(
    runtime.supportedDeviceTypes
      .filter((type) => type.productFamily === 'iPhone')
      .map((type) => type.identifier),
  )
  const deviceType = newest(
    devicetypes.filter((type) => supported.has(type.identifier)),
    (type) => type.minRuntimeVersionString,
  )
  if (!deviceType) throw new Error(`runtime ${runtime.identifier} supports no iPhone`)

  const name = `verify-${runId}`
  const udid = (
    await capture(['xcrun', 'simctl', 'create', name, deviceType.identifier, runtime.identifier], {
      timeoutMs: 2 * MINUTE_MS,
    })
  ).trim()
  cleanups.push({
    what: `simulator ${udid}`,
    run: async () => {
      await run(['xcrun', 'simctl', 'shutdown', udid], { timeoutMs: 2 * MINUTE_MS }).catch(() => {
        // a simulator that never booted has nothing to shut down
      })
      await run(['xcrun', 'simctl', 'delete', udid], { timeoutMs: 2 * MINUTE_MS })
    },
  })
  log(`ios: created simulator ${name} (${deviceType.name}, iOS ${runtime.version}) ${udid}`)
  await run(['xcrun', 'simctl', 'bootstatus', udid, '-b'], { timeoutMs: DEVICE_BOOT_TIMEOUT_MS })
  return udid
}

async function verifyIos(port: number): Promise<void> {
  if (hostPlatform() !== 'darwin') throw new Error('the ios leg needs macOS with Xcode')
  const udid = await createSimulator()
  log('ios: one run:ios')
  await run(['bun', 'run', 'ios', '--udid', udid], {
    cwd: appDir,
    env: { WEB_PORT: String(port) },
    timeoutMs: NATIVE_BUILD_TIMEOUT_MS,
  })
  await proveNativeApp({ platform: 'ios', udid }, 'Swift')
}

function androidSdk(): string {
  const sdk =
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    (hostPlatform() === 'darwin' ? join(homedir(), 'Library', 'Android', 'sdk') : undefined)
  if (!sdk || !existsSync(sdk)) throw new Error('set ANDROID_HOME to an Android SDK')
  return sdk
}

// The newest installed google_apis image for this host's CPU, unless
// VERIFY_ANDROID_IMAGE names one (for example system-images;android-35;google_apis;x86_64).
function androidImage(sdk: string): string {
  const configured = process.env.VERIFY_ANDROID_IMAGE
  if (configured) return configured
  const abi = hostArch() === 'arm64' ? 'arm64-v8a' : 'x86_64'
  const imagesDir = join(sdk, 'system-images')
  const levels = existsSync(imagesDir)
    ? readdirSync(imagesDir).filter((level) =>
        existsSync(join(imagesDir, level, 'google_apis', abi)),
      )
    : []
  // Directories are named android-<API level>.
  const level = newest(levels, (name) => name.replace(/\D/g, ''))
  if (!level) {
    throw new Error(
      `no google_apis ${abi} system image under ${imagesDir}; install one with sdkmanager`,
    )
  }
  return `system-images;${level};google_apis;${abi}`
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

// An emulator takes an even console port and the adb port after it.
async function freeEmulatorPort(): Promise<number> {
  for (let port = 5600; port <= 5680; port += 2) {
    if ((await portFree(port)) && (await portFree(port + 1))) return port
  }
  throw new Error('no free emulator port pair in 5600-5681')
}

async function createEmulator(sdk: string): Promise<string> {
  const image = androidImage(sdk)
  const avdHome = join(outDir, 'avd')
  const env = { ANDROID_HOME: sdk, ANDROID_AVD_HOME: avdHome }
  const name = `verify-${runId}`
  const adb = join(sdk, 'platform-tools', 'adb')
  mkdirSync(avdHome, { recursive: true })

  const avdmanager = join(sdk, 'cmdline-tools', 'latest', 'bin', 'avdmanager')
  log(`android: creating emulator ${name} from ${image}`)
  const create = Bun.spawn(
    [avdmanager, 'create', 'avd', '--name', name, '--package', image, '--device', 'pixel_7'],
    {
      env: { ...process.env, ...env },
      stdin: new Blob(['no\n']),
      stdout: 'inherit',
      stderr: 'inherit',
      timeout: 5 * MINUTE_MS,
    },
  )
  if ((await create.exited) !== 0) throw new Error(`avdmanager create avd ${name} failed`)
  cleanups.push({
    what: `AVD ${name}`,
    run: async () => {
      rmSync(join(avdHome, `${name}.avd`), { recursive: true, force: true })
      rmSync(join(avdHome, `${name}.ini`), { force: true })
    },
  })

  const port = await freeEmulatorPort()
  const serial = `emulator-${port}`
  const emulator = Bun.spawn(
    [
      join(sdk, 'emulator', 'emulator'),
      '-avd',
      name,
      '-port',
      String(port),
      '-no-window',
      '-no-snapshot',
      '-no-audio',
      '-no-boot-anim',
      '-gpu',
      'swiftshader_indirect',
    ],
    {
      env: { ...process.env, ...env },
      stdout: Bun.file(join(outDir, 'android-emulator.log')),
      stderr: 'inherit',
    },
  )
  cleanups.push({
    what: `emulator ${serial}`,
    run: async () => {
      await run([adb, '-s', serial, 'emu', 'kill'], { timeoutMs: MINUTE_MS }).catch(() => {
        // the console may already be gone; the process kill below still applies
      })
      const exited = await Promise.race([emulator.exited, Bun.sleep(MINUTE_MS).then(() => null)])
      if (exited === null) emulator.kill('SIGKILL')
      await emulator.exited
    },
  })

  log(`android: booting ${serial}`)
  await waitFor(`${serial} to finish booting`, DEVICE_BOOT_TIMEOUT_MS, async () => {
    if (emulator.exitCode !== null) throw new Error(`emulator exited with ${emulator.exitCode}`)
    const proc = Bun.spawn([adb, '-s', serial, 'shell', 'getprop', 'sys.boot_completed'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    })
    const output = await new Response(proc.stdout).text()
    await proc.exited
    return output.trim() === '1'
  })
  return serial
}

async function verifyAndroid(port: number): Promise<void> {
  const sdk = androidSdk()
  const serial = await createEmulator(sdk)
  const adb = join(sdk, 'platform-tools', 'adb')
  log('android: one run:android')
  await run(['bun', 'run', 'android'], {
    cwd: appDir,
    env: { WEB_PORT: String(port), ANDROID_HOME: sdk, ANDROID_SERIAL: serial },
    timeoutMs: NATIVE_BUILD_TIMEOUT_MS,
  })
  // A loaded host can raise "System UI isn't responding", which agent-device
  // will not press through; dismiss system dialogs before driving the app.
  await run(
    [
      adb,
      '-s',
      serial,
      'shell',
      'am',
      'broadcast',
      '-a',
      'android.intent.action.CLOSE_SYSTEM_DIALOGS',
    ],
    {
      timeoutMs: MINUTE_MS,
    },
  )
  await proveNativeApp({ platform: 'android', serial }, 'Kotlin')
}

async function cleanUp(): Promise<boolean> {
  let clean = true
  // Undo in reverse order of setup.
  for (let index = cleanups.length - 1; index >= 0; index--) {
    const cleanup = cleanups[index]!
    try {
      await cleanup.run()
    } catch (error) {
      clean = false
      console.error(
        `[verify] cleanup of ${cleanup.what} failed: ${error instanceof Error ? error.message : error}`,
      )
    }
  }
  return clean
}

async function main(): Promise<void> {
  const { legs, devServer } = parseOptions(process.argv.slice(2))
  mkdirSync(outDir, { recursive: true })
  log(`legs: ${legs.join(', ')}; artifacts in ${outDir}`)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void cleanUp().finally(() => process.exit(130))
    })
  }

  let failure: unknown
  try {
    if (legs.includes('static')) await verifyStatic()
    const appLegs = legs.filter((leg) => leg !== 'static')
    if (appLegs.length > 0) {
      const port = devServer === 'silo' ? await startSiloDevServer() : await startDirectDevServer()
      if (legs.includes('web')) await verifyWeb(port)
      if (legs.includes('ios')) await verifyIos(port)
      if (legs.includes('android')) await verifyAndroid(port)
    }
  } catch (error) {
    failure = error
  }
  const clean = await cleanUp()
  if (legs.some((leg) => leg === 'ios' || leg === 'android')) {
    await run(['agent-device', 'daemon', 'stop'], {
      env: agentDeviceEnv,
      timeoutMs: MINUTE_MS,
    }).catch(() => {
      // no daemon started when no device command ran
    })
  }

  if (failure !== undefined) {
    console.error(`\n[verify] FAILED: ${failure instanceof Error ? failure.message : failure}`)
    process.exit(1)
  }
  if (!clean) {
    console.error('\n[verify] legs passed, but cleanup failed; see the errors above')
    process.exit(1)
  }
  log(`passed: ${legs.join(', ')}`)
}

await main()
