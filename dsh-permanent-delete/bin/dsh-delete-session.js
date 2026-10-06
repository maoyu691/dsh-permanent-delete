#!/usr/bin/env node
import { permanentDeleteSession, resolveSessionRoot, confirmationText } from '../lib/delete-session.js'

function usage() {
  return `Usage:
  dsh-delete-session <session-id> [--root <path>] [--cwd <path>] [--dry-run]
  dsh-delete-session <session-id> --root <path> --yes "PERMANENTLY DELETE <session-id>"

Options:
  --root <path>              JSONL session root. Defaults to DSH_SESSION_ROOT,
                             DSH_SESSIONS_ROOT, $DSH_HOME/sessions, or ~/.dsh/sessions.
  --cwd <path>               Narrow to the project directory for this cwd.
  --dry-run                  Inspect matches only. This is the default.
  --yes <confirmation>       Required to delete. Exact text: PERMANENTLY DELETE <session-id>
  --allow-multiple-matches   Delete all duplicate matches after dry-run review.
  -h, --help                 Show help.
`
}

function parseArgv(argv) {
  const parsed = {
    sessionId: undefined,
    root: undefined,
    cwd: undefined,
    dryRun: true,
    confirm: undefined,
    allowMultipleMatches: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') return { help: true }
    if (arg === '--root') {
      parsed.root = argv[++i]
    } else if (arg === '--cwd') {
      parsed.cwd = argv[++i]
    } else if (arg === '--dry-run') {
      parsed.dryRun = true
    } else if (arg === '--yes') {
      parsed.confirm = argv[++i]
      parsed.dryRun = false
    } else if (arg === '--allow-multiple-matches') {
      parsed.allowMultipleMatches = true
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`)
    } else if (parsed.sessionId === undefined) {
      parsed.sessionId = arg
    } else {
      throw new Error(`unexpected argument: ${arg}`)
    }
  }

  return parsed
}

function printResult(result) {
  console.log(result.deleted ? 'Deleted permanently.' : 'Dry run; nothing deleted.')
  console.log(`root: ${result.root}`)
  console.log(`sessionId: ${result.sessionId}`)
  console.log(`matches: ${result.matches.length}`)
  for (const match of result.matches) {
    console.log('')
    console.log(match.path)
    console.log(`  files: ${match.fileCount}`)
    console.log(`  directories: ${match.directoryCount}`)
    console.log(`  bytes: ${match.byteCount}`)
    console.log(`  deleted: ${match.deleted}`)
  }
  if (!result.deleted) {
    console.log('')
    console.log(`Delete command confirmation: --yes "${confirmationText(result.sessionId)}"`)
  }
}

try {
  const args = parseArgv(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    process.exit(0)
  }
  if (!args.sessionId) throw new Error('missing session id')

  const result = await permanentDeleteSession({
    root: resolveSessionRoot(args.root),
    sessionId: args.sessionId,
    cwd: args.cwd,
    dryRun: args.dryRun,
    confirm: args.confirm,
    allowMultipleMatches: args.allowMultipleMatches,
  })
  printResult(result)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error('')
  console.error(usage())
  process.exit(1)
}
