#!/usr/bin/env node
/**
 * Fetches ui_bridge.proto from rovi_ros_ws (GitHub main branch).
 * Run manually: pnpm fetch-proto
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROTO_URL =
  'https://raw.githubusercontent.com/Roblibs/rovi_ros_ws/main/src/ros_ui_bridge/proto/ui_bridge.proto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outPath = path.resolve(__dirname, '..', 'proto', 'ui_bridge.proto')

async function main() {
  console.log(`Fetching proto from:\n  ${PROTO_URL}`)

  const res = await fetch(PROTO_URL)
  if (!res.ok) {
    throw new Error(`Failed to fetch proto: ${res.status} ${res.statusText}`)
  }

  const content = await res.text()

  // Ensure proto/ directory exists
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, content, 'utf8')

  console.log(`Written to:\n  ${outPath}`)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
