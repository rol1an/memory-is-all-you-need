#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}

if (has('--help') || has('-h')) {
  console.log(`Memory Is All You Need — a star map for Claude Code's memory

Usage: npx memory-is-all-you-need [options]

Options:
  --demo         serve the bundled sample galaxy (real structure, placeholder
                 text) — nothing on your machine is read
  --dir <path>   memory root to scan (default: ~/.claude/projects)
  --port <n>     port to listen on (default: 5611, localhost only)
  --anonymize    your real graph with placeholder titles — safe for
                 screenshots and screen recording (read-only)
  --feishu       enable the optional Feishu review-card listener
                 (off by default when launched from this CLI)
  -h, --help     show this help
`)
  process.exit(0)
}

// --dir 在 chdir 前解析成绝对路径；chdir 到包根让 ./dist 与 ./demo 的相对路径成立
const dir = val('--dir')
if (dir) process.env.CLAUDE_PROJECTS_DIR = path.resolve(dir)
const port = val('--port')
if (port) process.env.PORT = port
if (has('--demo')) process.env.LENS_DEMO = '1'
if (has('--anonymize')) process.env.LENS_ANONYMIZE = '1'
if (!has('--feishu') && process.env.LENS_NO_FEISHU === undefined) process.env.LENS_NO_FEISHU = '1'

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
await import('../dist-server/index.js')
