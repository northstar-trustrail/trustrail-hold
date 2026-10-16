# Operations workspace handoff

Open `/operations.html`. Use `/operations.html?workflow=expiring&hours=24` for an agent-planned view. `hold=H-0002&criterion=Q-1&theme=dark` selects an evidence view when that hold exists. The browser-only build supports the same view tool and ephemeral mock holds; server state is durable.

The tool is `build_expiring_review_view` in MCP. It can read the caller's permitted holds and produce the fixed filter/sort plan defined in `src/core/operations.js`. It cannot supply arbitrary filter fields or payment actions. The workspace uses that shared implementation and validates the plan before applying Community grid filters. The app's resolve/approval buttons call the existing authorized API. Pending or ambiguous payments have no workspace settlement buttons.

The earliest delivery deadline, honor-period boundary, or authorization expiry drives the countdown. The 1-72 hour window includes overdue unresolved holds; final states and unknown clocks are excluded. Missing clocks still appear in the unfiltered workspace. The budget exposure cards cover all holds, while the review queue follows the agent view. A confirmed capture requires PayPal `COMPLETED`, even when the verifier requested capture. Captures awaiting refunds remain in the captured total until the refund completes.

AG Grid's [AI Toolkit documentation](https://www.ag-grid.com/javascript-data-grid/ai-toolkit/) marks `AiToolkitModule` Enterprise. That module is absent from this repository's Community bundle. The separate [Studio Agent Framework](https://www.ag-grid.com/studio/javascript/ai/) uses the Studio package. This workspace uses the bundled Community API and an application-owned MCP view tool. It adds no LLM credentials, external model calls, or paid package. Existing Community licensing remains unchanged.

## Verification

- `npm test`: 46 tests, 40 passed, 6 model-dependent skips, 0 failures. Operation classification, expiry boundaries, read-only plan validation, MCP invocation, and HTTP authorization pass. Payment tests cover pending statuses, duplicate guards, durable budgets, lost responses, restart recovery, and verified webhook reconciliation.
- `npm run build:pages`: succeeds; the static build includes the workspace, shared operations tool, and frozen verifier config.
- `node --check web/app.js` and `node --check web/operations.js`: pass.
- Browser inspection: empty and populated light layouts, dark layout, 24-hour filtered view, selected escalated hold, criterion references, and evidence deep link rendered. Four synthetic mock holds totaled $300; the agent view selected three totaling $255 and excluded the 48-hour hold.
- Direct click automation timed out. A complete browser click-through of theme toggles, row selection, reference buttons, and review buttons remains unverified. The underlying plan and settlement API paths are tested. No live PayPal money operation ran.
- The new MiniLM source smoke test and five pre-existing model tests skip because the optional dependency is unavailable in this restricted environment. EVAL.md distinguishes measured fallback results from unmeasured MiniLM runs.

## Local commit storage

The environment grants read-only access to the existing `.git` directory and rejects creating `.git/index.lock`. The four item commits live in `.local-history`, a separate local metadata directory whose working tree is this repository. No push was attempted. Runtime data and the alternate history are gitignored.

After restoring write access to the original Git metadata, import the local history without changing the working files:

```powershell
git fetch .local-history main
git reset --mixed FETCH_HEAD
```

This advances the current branch to the four local commits and updates the index. Inspect the commits first with `git --git-dir=.local-history log -4 --oneline`. Do not reset if you have made additional changes you want to keep staged.
