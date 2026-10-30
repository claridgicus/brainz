# demos — screencasts of Brainz Cloud, kept honest

The marketing site (and the OpenAI directory submission) shows short clips of
Brainz Cloud doing real work: an AI app being connected to a vault, a vault's
knowledge graph. They are recorded, not drawn — Playwright drives the real app
on a local compose stack — and rendered Screen Studio style: 60fps, a faux
cursor that glides and clicks, the camera zooming toward the work and out
again. Ported from manifold's `demos/`.

Every clip is recorded in a **demo account made for it** (`src/tenant.ts`),
never anyone's real data. Each run brings up a fresh stack (`compose.yaml`,
service `cloud`: the built worker under `wrangler dev --local`, its D1 and
Durable Object state on a tmpfs). Each demo signs up its persona from the
manifest (`alex.morgan@acme.example`, …) the way a person does — a magic
link, read from the email the stack's mail stub wrote — and fills a
"Brainz demo" vault with what the directory reviewers get: the
`examples/demo-vault` concepts plus `docs/submissions/seed-reviewer-vault.mjs`'s
Acme CRM product and task pile. So a clip shows the same account and graph
every time it is recorded.

A clip is only true while the screens it shows are the screens we ship, so
every clip carries a fingerprint of its sources (`fingerprints.json`). CI runs
`demos:check` warn-only: a stale clip shows as a failed, allowed step and
never blocks. Re-record, commit the new files, and push when convenient.

## Commands

Run recordings through `mheavy` (the machine's CPU-block queue): the browser,
every render's ffmpeg and the stack's container keep to the block it hands out.

```sh
mheavy npm run demos:record                          # the stale demos → apps/marketing/static/demos/
mheavy npm run demos:record -- --all                 # every demo, stale or not
mheavy npm run demos:record -- dashboard-graph       # one demo (ids: src/manifest.ts)
mheavy npm run demos:record -- consent-and-connect --headed --keep   # watch it; keep frames under demos/.takes/
npm run demos:check                                  # what CI runs: fast, no browser, no stack
npm run demos:stack -- up|down|logs                  # the stack by hand, to look around in
```

`record` builds engine, contracts and the cloud app first (`--no-build` skips
it), starts the stack, and takes it down at the end (`--keep-stack` leaves it
up). Outside `mheavy`, set `DEMOS_CPUS=8-15` to pin it. The stack is named
after the worktree and gets its own port (8800–8899), so worktrees record side
by side; `BRAINZ_DEMOS_PORT` overrides the port. Playwright's Chromium must be
installed (`npx playwright install chromium`), and `ffmpeg` on PATH.

Each demo produces four files: `<id>.mp4` (the marketing cut: the app as a
rounded window on a dark violet canvas), `<id>-bleed.mp4` (the edge-to-edge
cut), `<id>.webp` (the marketing cut's poster, once the first zoom is over)
and `<id>-bleed.webp` (the bleed cut's poster: its first frame). The site
embeds them with `$lib/components/Demo.svelte`:

```svelte
<Demo id="dashboard-graph" title="A vault's knowledge graph" />
```

## The demos

| id | what it shows |
|---|---|
| `consent-and-connect` | An app registers over OAuth (DCR) and opens the consent page; seven vaults put the picker in search mode; search, pick Brainz demo and Mobile app, drop the pre-ticked one, Allow; the app's callback gets a code (asserted). |
| `dashboard-graph` | Dashboard → the vault's graph settling → search "lead scoring" → the spec's panel and links → hop along one → the task board. |
| `openai-review` | The Brainz-side shots of the OpenAI review video: title card, the PostHog decision (what test case P5 writes) in the graph linked to Lead Scoring, end card. The ChatGPT shots are recorded by hand — see `docs/submissions/openai.md`, "Recording the demo video". |

## Adding a demo

1. Write a flow in `src/flows/`: prepare what it needs through the REST API
   (`context.api`, signed in as the demo account) before the clock, then
   `enter`, `begin`, and drive the take. The `Take` speaks in intentions:
   `click`, `type`, `fill`, `select`, `hover`, `moveTo`, `scrollTo`,
   `waitFor`, `pause`, `card` (a title or end card), `reveal` (step the
   camera back to the whole screen — the only thing that zooms out, so call
   it when a minor step is done, not between the actions of one).
2. Add it to `DEMOS` in `src/manifest.ts` with a persona of its own and the
   globs of the sources it shows. Every demo also depends on the implicit set
   in `src/fingerprint.ts`: the recorder, `compose.yaml`, the seed data, and
   the dashboard's shared chrome (`app.css`, layouts, `lib/components`).
3. Record it, embed it, stage the outputs with `demos/fingerprints.json`.

A take sits through a hold only until the page stops painting, then adds the
rest to the clip's clock without sleeping it (`clock.ts`), and the cursor's
glides are added the same way, so recording is quicker than the clip is long.
Each cut renders in six-second segments side by side, joined without
re-encoding. Every child (a seed, a take, a render segment) is stopped after
three minutes (`--timeout <s>`). `--real-time` sits through every hold, for a
flow whose screen moves while it should be still.

## How it works

- `stack.ts` — the compose stack: project and port per worktree, the CPU
  block handed to the container (`cpuset`), up/down/logs.
- `tenant.ts` — the demo account: sign-up by magic link, the seeded vaults.
- `clock.ts` — the take's clock: real time plus the still part of every
  hold, credited rather than slept, with frames stamped by when the browser
  captured them.
- `take.ts` — the driver. The pointer glides on an ease (the real mouse
  follows the same path, so hover states light up), every click, keystroke
  and reveal is logged on the take's clock, and a CDP screencast delivers
  each frame the page paints, stamped on the same clock.
- `timeline.ts` — the motion, pure: the cursor between its keyframes, click
  ripples, and the camera's keyframes from the moments.
- `layout.ts` — where the page sits on the 1920×1080 canvas per cut.
- `compose.ts` — the render: 60 frames a second onto a native canvas, piped
  raw into ffmpeg as H.264, held frames repeated rather than repainted.
- `fingerprint.ts` — the gate: a sha256 over the sorted `<path> <git blob id>`
  lines of every matching source. The check reads the index
  (`git ls-files -s`) or, with `--rev`, a commit's tree; the recorder hashes
  the working tree; they agree whenever what you commit is what you recorded.
