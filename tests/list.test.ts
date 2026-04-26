// mission-bullet — task-counter invariants for `bullet list` / `bullet tasks`.
//
// Locks in the accepted task forms so a future refactor can't quietly
// drop one of them:
//   - [ ]  GFM open
//   - []   No-space shorthand open (no space between brackets)
//   - [x]  done
//   - [X]  done

import { describe, expect, test } from "bun:test";
import { countTasks } from "../src/list";

describe("countTasks", () => {
  test("treats `- []` (no space) as an open task", () => {
    const body = "- [] Message Lena\n- [] Refresh Joey's water\n";
    expect(countTasks(body)).toEqual({ open: 2, done: 0 });
  });

  test("treats `- [ ]` (with space) as an open task", () => {
    const body = "- [ ] classic GFM open\n";
    expect(countTasks(body)).toEqual({ open: 1, done: 0 });
  });

  test("treats `- [x]` and `- [X]` as done", () => {
    const body = "- [x] lowercase done\n- [X] uppercase done\n";
    expect(countTasks(body)).toEqual({ open: 0, done: 2 });
  });

  test("ignores non-task bullets", () => {
    const body = [
      "- ! urgent flag, not a task",
      "- * observation bullet, not a task",
      "- plain bullet, not a task",
      "",
    ].join("\n");
    expect(countTasks(body)).toEqual({ open: 0, done: 0 });
  });

  test("mixed entry (matches the 2026-04-22 shape)", () => {
    const body = [
      "- ! Claude usage at 96% until Thursday",
      "- ! Deli tab $21",
      "- [] Message Lena",
      "- [] Refresh Joey's water",
      "- [] Try to schedule recording",
      "- * Consider rebranding twitter",
      "- [] Cross-reference CSL emails",
      "- [] Message David Pollack",
      "- [] Offer John Denicola vault",
      "- Would like to eventually save up for a Mac",
      "",
    ].join("\n");
    expect(countTasks(body)).toEqual({ open: 6, done: 0 });
  });
});
