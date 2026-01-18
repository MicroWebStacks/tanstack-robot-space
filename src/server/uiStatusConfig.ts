import fs from 'node:fs'
import path from 'node:path'

import { loadRootEnvOnce } from './env'

export type UiStatusFieldConfig = {
  id: string
  label: string
}

export type UiStatusConfig = {
  fields: UiStatusFieldConfig[]
  selectedIds: string[]
  labelsById: Record<string, string>
}

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

function parseYamlStatusFields(yaml: string): UiStatusFieldConfig[] {
  const lines = yaml.split(/\r?\n/)
  const out: UiStatusFieldConfig[] = []

  let inStatus = false
  let statusIndent: number | null = null

  let inFields = false
  let fieldsIndent: number | null = null

  let activeItemIndent: number | null = null
  let activeId: string | null = null
  let activeLabel: string | null = null

  const flushActive = () => {
    if (!activeId && !activeLabel) return
    if (!activeId) {
      throw new Error('Invalid config: status.fields item missing id')
    }
    if (!activeLabel) {
      throw new Error(`Invalid config: status.fields.${activeId} missing label`)
    }
    out.push({ id: activeId, label: activeLabel })
    activeId = null
    activeLabel = null
    activeItemIndent = null
  }

  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine)
    if (!line.trim()) continue

    const indent = line.match(/^\s*/)?.[0].length ?? 0

    if (!inStatus) {
      const statusMatch = line.match(/^\s*status\s*:\s*$/)
      if (!statusMatch) continue
      inStatus = true
      statusIndent = indent
      continue
    }

    if (statusIndent == null) break
    if (indent <= statusIndent) break

    if (!inFields) {
      const fieldsMatch = line.match(/^\s*fields\s*:\s*$/)
      if (!fieldsMatch) continue
      inFields = true
      fieldsIndent = indent
      continue
    }

    if (fieldsIndent == null) break
    if (indent <= fieldsIndent) break

    const itemMatch = line.match(/^\s*-\s*(.*)\s*$/)
    if (itemMatch) {
      flushActive()
      activeItemIndent = indent
      const rest = (itemMatch[1] ?? '').trim()
      if (rest) {
        const idInlineMatch = rest.match(/^id\s*:\s*(.+?)\s*$/)
        if (!idInlineMatch) {
          throw new Error(
            `Invalid config: status.fields item must start with "- id: ...", got "${rest}"`,
          )
        }
        activeId = stripYamlQuotes(idInlineMatch[1] ?? '').trim() || null
      }
      continue
    }

    if (activeItemIndent == null) {
      continue
    }

    if (indent <= activeItemIndent) {
      continue
    }

    const kvMatch = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+?)\s*$/)
    if (!kvMatch) continue

    const key = kvMatch[1] ?? ''
    const value = stripYamlQuotes(kvMatch[2] ?? '').trim()

    if (key === 'id') activeId = value || null
    if (key === 'label') activeLabel = value || null
  }

  flushActive()
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

export function getUiStatusConfig(): UiStatusConfig {
  const configPath = resolveUiConfigPath()

  let text: string
  try {
    text = fs.readFileSync(configPath, 'utf8')
  } catch (err) {
    const suffix = err instanceof Error ? `: ${err.message}` : ''
    throw new Error(
      `UI status config missing or unreadable at "${configPath}"${suffix}`,
    )
  }

  const fields = parseYamlStatusFields(text)
  if (!fields.length) {
    throw new Error(
      `Invalid UI status config at "${configPath}": status.fields must be a non-empty list`,
    )
  }

  const labelsById: Record<string, string> = {}
  const selectedIds: string[] = []
  for (const field of fields) {
    if (!field.id) {
      throw new Error(
        `Invalid UI status config at "${configPath}": status.fields item missing id`,
      )
    }
    if (!field.label) {
      throw new Error(
        `Invalid UI status config at "${configPath}": status.fields.${field.id} missing label`,
      )
    }
    if (labelsById[field.id]) {
      throw new Error(
        `Invalid UI status config at "${configPath}": duplicate id "${field.id}"`,
      )
    }
    selectedIds.push(field.id)
    labelsById[field.id] = field.label
  }

  return { fields, selectedIds, labelsById }
}
