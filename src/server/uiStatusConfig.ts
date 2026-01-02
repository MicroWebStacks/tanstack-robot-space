import fs from 'node:fs'
import path from 'node:path'

import { loadRootEnvOnce } from './env'

const DEFAULT_SELECTED_IDS = [
  'cpu_percent',
  'battery_voltage_v',
  'hz_driver',
  'hz_odom',
  'hz_lidar',
  'hz_slam',
]

function stripInlineComment(line: string): string {
  const hashIdx = line.indexOf('#')
  return hashIdx === -1 ? line : line.slice(0, hashIdx)
}

function stripYamlQuotes(raw: string): string {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseYamlListUnderKey(yaml: string, key: string): string[] {
  const lines = yaml.split(/\r?\n/)
  const out: string[] = []

  let listIndent: number | null = null
  let inList = false

  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine)
    if (!line.trim()) continue

    const indent = line.match(/^\s*/)?.[0].length ?? 0

    if (!inList) {
      const keyMatch = line.match(new RegExp(`^\\s*${key}\\s*:\\s*$`))
      if (!keyMatch) continue
      inList = true
      listIndent = indent
      continue
    }

    if (listIndent == null) break
    if (indent <= listIndent) break

    const itemMatch = line.match(/^\s*-\s*(.+?)\s*$/)
    if (!itemMatch) continue
    const value = stripYamlQuotes(itemMatch[1] ?? '')
    if (value) out.push(value)
  }

  return out
}

function resolveUiConfigPath(): string {
  loadRootEnvOnce()
  const raw =
    process.env.UI_WEB_CONFIG ??
    process.env.UI_WEB_CONFIG_PATH ??
    process.env.UI_CONFIG ??
    process.env.UI_CONFIG_PATH ??
    ''

  if (raw) {
    const trimmed = raw.trim()
    return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed)
  }

  return path.resolve(process.cwd(), 'config', 'ui.yaml')
}

export function getUiSelectedStatusIds(): string[] {
  const configPath = resolveUiConfigPath()

  try {
    const text = fs.readFileSync(configPath, 'utf8')
    const ids = parseYamlListUnderKey(text, 'selected_ids')
    return ids.length ? ids : DEFAULT_SELECTED_IDS
  } catch {
    return DEFAULT_SELECTED_IDS
  }
}

