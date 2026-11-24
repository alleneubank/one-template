#!/usr/bin/env bun

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

// Split to avoid self-replacement
const OLD_SCOPE = ['@', 'template'].join('')
const OLD_APP_NAME = ['Template', 'App'].join('')
const OLD_APP_ID = ['dev', 'template', 'app'].join('.')

const APP_IDENTITY = join('apps', 'app', 'app.identity.ts')

// Xcode project and scheme name: letters and digits, starting with a letter.
const APP_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/
// iOS bundle id and Android application id: two or more dot-separated
// segments, each a letter followed by letters, digits, or underscores.
const APP_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/

type Replacement = { from: string; to: string }

type Answers = { scope: string; appName: string; appId: string }

function fail(message: string): never {
  console.error(`Error: ${message}`)
  process.exit(1)
}

// One interface for every question, read as a line stream, so answers piped
// on stdin are not lost between prompts.
async function readAnswers(): Promise<Answers> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const lines = rl[Symbol.asyncIterator]()
  const ask = async (question: string): Promise<string> => {
    process.stdout.write(question)
    const line = await lines.next()
    return line.done ? '' : line.value.trim()
  }
  try {
    const scope = await ask('Package scope (e.g., @myorg): ')
    if (!scope) fail('scope is required')
    if (!scope.startsWith('@')) fail('scope must start with @')

    const appName = await ask('App name, letters and digits (e.g., MyApp): ')
    if (!APP_NAME_PATTERN.test(appName)) fail(`app name must match ${APP_NAME_PATTERN}`)

    const appId = await ask('App id, reverse DNS (e.g., com.myorg.myapp): ')
    if (!APP_ID_PATTERN.test(appId)) fail(`app id must match ${APP_ID_PATTERN}`)

    return { scope, appName, appId }
  } finally {
    rl.close()
  }
}

async function findFiles(dir: string, pattern: RegExp): Promise<string[]> {
  const results: string[] = []

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true })
    const dirs: string[] = []

    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name)
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'dist', 'build', 'scripts'].includes(entry.name)) {
          dirs.push(fullPath)
        }
      } else if (pattern.test(entry.name)) {
        results.push(fullPath)
      }
    }

    await Promise.all(dirs.map((d) => walk(d)))
  }

  await walk(dir)
  return results
}

async function replaceInFile(
  filePath: string,
  replacements: readonly Replacement[],
): Promise<{ path: string; changed: boolean }> {
  const content = await readFile(filePath, 'utf-8')
  const updated = replacements.reduce((text, { from, to }) => text.replaceAll(from, to), content)
  if (updated === content) {
    return { path: filePath, changed: false }
  }
  await writeFile(filePath, updated)
  return { path: filePath, changed: true }
}

async function main(): Promise<void> {
  console.log('Template Setup')
  console.log('==============\n')

  const { scope, appName, appId } = await readAnswers()

  const root = join(import.meta.dirname, '..')
  const scopeReplacement: Replacement = { from: OLD_SCOPE, to: scope }
  const appReplacements: readonly Replacement[] = [
    scopeReplacement,
    { from: OLD_APP_NAME, to: appName },
    { from: OLD_APP_ID, to: appId },
  ]

  console.log(
    `\nReplacing ${OLD_SCOPE} → ${scope}, ${OLD_APP_NAME} → ${appName}, ${OLD_APP_ID} → ${appId}...\n`,
  )

  const files = await findFiles(root, /\.(json|ts|tsx)$/)
  const appIdentity = join(root, APP_IDENTITY)
  const results = await Promise.all(
    files.map((f) => replaceInFile(f, f === appIdentity ? appReplacements : [scopeReplacement])),
  )

  let count = 0
  for (const { path, changed } of results) {
    if (changed) {
      console.log(`  Updated: ${path.replace(root + '/', '')}`)
      count++
    }
  }

  console.log(`\nDone! Updated ${count} files.`)
  console.log('\nNext steps:')
  console.log('  1. Update root package.json "name" field')
  console.log('  2. Replace or delete LICENSE — it covers the template, not your project')
  console.log('  3. Run: bun install')
  console.log('  4. Run: bun run verify')
}

main()
