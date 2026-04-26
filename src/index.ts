// mission-bullet — CLI entrypoint.
//
// Minimal dispatcher: routes subcommands to their handlers. Wider
// arg parsing / --help-per-subcommand / --dry-run lands with mb-008.

import { runClaudeNote } from "./claude-note";
import { runList, runTasks } from "./list";
import { runMigrate } from "./migrate-day";
import { runMonth } from "./month";
import { runReviewWeek } from "./review";
import { runToday } from "./today";

function printUsage(): void {
  console.log(`mission-bullet — personal AI-assisted bullet journal

Daily:
  bullet today                     Open today's entry in your editor
  bullet month [YYYY-MM]           Open the monthly log (goals, bills, calendar)
  bullet migrate [--from YYYY-MM-DD] [--to YYYY-MM-DD]
                                   Daily migration: prompt y/n/strike/quit per
                                   open task on a prior entry; carry accepted
                                   forward, mark struck. Defaults: source =
                                   most recent prior entry with open tasks
                                   (typically yesterday), dest = today.

Review:
  bullet review week [YYYY-WNN]    Weekly review — surface themes + migrations,
                                   capture decisions, carry accepted items
                                   forward to next Monday. Default: current week.
  bullet review month [YYYY-MM]    Monthly review — same shape, month-wide.
                                   Accepted items land in next month's monthly
                                   log. Default: current month.
  bullet claude-note [YYYY-MM-DD]  Open/create the parallel-notes sibling file
                                   for a day's entry (defaults to today). Used
                                   to save AI commentary on an entry alongside
                                   the raw entry. Pass
                                   --ask "<question>" to invoke a provider and
                                   append the streamed response. --provider
                                   <claude|openrouter|ollama> picks a provider
                                   for this call; --model <id> picks a model
                                   (e.g. sonnet / haiku / opus for --provider
                                   claude); --dry-run uses a canned response.
  bullet ask "<question>" [YYYY-MM-DD]
                                   Sugar for "claude-note --ask <question>"
                                   with today's date as the default. The
                                   common case for everyday use.

Browse:
  bullet list [--week|--month|--since YYYY-MM-DD|--all]
                                   List entries with task/session counts
  bullet tasks [--open|--done|--all]
                                   Roll up GFM-style tasks (- [ ]) across entries

Other:
  bullet help                      Show this message

Most commands accept --dry-run to use canned LLM responses (cheap iteration).

Configuration (via environment variables — see .env.example):
  MISSION_BULLET_EDITOR            Editor command (default: $EDITOR or notepad/nano)
  MISSION_BULLET_PROVIDER          Explicit LLM provider: claude | openrouter | ollama
  OPENROUTER_API_KEY               Cloud LLM provider
  OLLAMA_BASE_URL                  Local LLM provider
  MISSION_BULLET_LLM_MODEL         Model id for the chosen provider (review)
  MISSION_BULLET_CLAUDE_NOTE_MODEL Model id for \`claude-note --ask\` specifically
                                   (defaults to google/gemma-4-31b-it:free via OpenRouter)`);
}

async function main(): Promise<number> {
  const subcommand = process.argv[2];
  const rest = process.argv.slice(3);

  switch (subcommand) {
    case "today":
      return runToday();

    case "month":
      return runMonth(rest);

    case "migrate":
      return runMigrate(rest);

    case "list":
      return runList(rest);

    case "tasks":
      return runTasks(rest);

    case "claude-note":
      return runClaudeNote(rest);

    case "ask": {
      // Sugar for the common case: `bullet ask "question" [date] [flags]`
      // gets rewritten to `bullet claude-note --ask "question" ...` so
      // the handler's parser is a single source of truth.
      if (rest.length === 0) {
        console.error(
          'ask: missing question. Usage: bullet ask "your question here"',
        );
        return 2;
      }
      const [question, ...others] = rest;
      return runClaudeNote(["--ask", question!, ...others]);
    }

    case "review": {
      const reviewKind = rest[0];
      const reviewRest = rest.slice(1);
      if (reviewKind === "week") {
        return runReviewWeek(reviewRest);
      }
      if (reviewKind === "month") {
        const { runReviewMonth } = await import("./review");
        return runReviewMonth(reviewRest);
      }
      console.error(
        `review: expected 'week' or 'month' after 'review', got '${reviewKind ?? ""}'`,
      );
      return 2;
    }

    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      return 0;

    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      printUsage();
      return 1;
  }
}

process.exit(await main());
