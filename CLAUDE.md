# Working on Raven

Rules for every session that plans, writes or reviews code, docs, commits or releases in this repository. They override default behaviour, including the harness's own commit and pull request conventions.

## 1. The manifesto decides

Raven's product decisions are governed by two documents:

- `docs/manifesto/Raven Manifesto v02.md`: what Raven is, what it refuses to become, and the red lines.
- `docs/manifesto/raven_design_philosophy_manifesto.md`: how Raven looks, behaves and speaks.

Before planning a feature or a change people will notice, read the sections that apply. Always read them when the work touches presence, visibility, notifications, permissions or roles, moderation, data collection or retention, anything leaving the device or the server, AI, hosting, or wording.

- Run the **Product Decision Filter** (manifesto §25) on every feature, and the **Feature Design Filter** (design §19) on anything a user sees.
- Run the **Power Review Filter** (manifesto §26) on anything that changes visibility, moderation, identity, data, roles, AI or admin control. Write down the answers in the plan.
- Never build anything on the **Red Lines** (§24) or **Anti-Goals** (§23) lists. If a request conflicts with the manifesto, stop, name the section it conflicts with, and propose a redesign. Do not quietly comply, and do not quietly refuse.
- Defaults that follow from it: conservative with exposure, generous with control (§7.2). Collect the least data that works, and treat metadata as intimate (§17.6). Ask for consent before making someone visible, recording, or running AI on their communication. Self-hosted Raven must never be made worse to favour a hosted service. No dark patterns, no engagement loops, no artificial urgency.
- Lean means every feature justifies its cost in CPU, memory, bandwidth, complexity, security surface, maintenance and attention (§12.4, §17.4). Reliability comes before novelty (§17.5).
- Simple surface, deep basement: defaults for everyone, advanced controls for those who look for them (§3.2, design §4.4).
- Use the language in §31 and design §13. Never use the vocabulary Raven rejects (engagement, retention, growth hacks, productivity insights and the like).

## 2. Plans never enter the repository

- Never commit plans, specs, proposals, task lists, TODO lists or discussion notes written by an LLM. This includes plan-mode output and anything shaped like a build specification.
- Keep plans in the plan-mode plan file or the session scratchpad. If a plan has to stay in the working tree for a later session, put it under `docs/plans/`, which is gitignored. Never `git add -f` anything there.
- Before every commit, read the staged file list and unstage anything plan-like.
- What belongs in the repository is documentation of how Raven works now (`docs/architecture.md`, `docs/api.md`, `docs/self-hosting.md`, `docs/releasing.md` and the like). When a feature lands, update the document that describes the system. Do not commit the plan that produced it.

## 3. Commit messages

- Subject line: imperative, about 72 characters at most, saying what changed (for example "Draw video from raw I420 frames with WebGL2 instead of MJPEG").
- Body: why the change was needed, what now behaves differently, what was measured and how, and what was not verified. Follow the style of recent commits in `git log`.
- Write plainly and factually. No superlatives, hype words ("seamless", "blazing", "powerful", "exciting"), emoji or exclamation marks.
- State trade-offs, known gaps and regressions openly (manifesto §17.9).
- No AI attribution. Do not add a `Co-Authored-By` trailer for Claude or any other AI tool, and no "Generated with" line in commits or pull requests.
- When a commit includes someone else's work, keep their authorship, or add a `Co-Authored-By` trailer with the name and email they use.
- Commit only when asked. Never push, tag, publish or deploy unless Soroush asks for that step.

## 4. Release notes

- One file per version: `docs/release-notes/X.Y.Z.md`. Follow `docs/release-notes/0.1.12.md`: sections such as Added, Changed, Fixed and Removed, then Acknowledgements, then the full changelog link. The `raven-releases` skill covers building and publishing.
- Write for the people who use and host Raven. Say what changed for them in plain words. Explain how it works when it affects privacy, visibility, data, or what leaves the device or the server. State defaults, opt-ins and what server operators must set.
- Use only measured numbers, and say how they were measured.
- No advertising or marketing tone: no superlatives, no "we're excited", no calls to action, no emoji, no exclamation marks. Do not oversell a change. List removals and known limitations; never hide them.

## 5. Credit everyone who improved Raven

- Credit every person whose work improved Raven, whatever their role and however small the contribution: code, design, ideas and proposals, bug reports, testing, feedback, architecture advice, documentation, translation, infrastructure. A GitHub account is not required.
- Record it in two places: the Acknowledgements section of the release that ships the work, and `CREDITS.md`. Add or update the person's entry in the same change.
- Say concretely what they did and what it led to (as the 0.1.11 notes do).
- Use the name and link the person already has in `CREDITS.md` or past release notes. If neither exists, ask Soroush how to name them. Never guess a name and never look someone up elsewhere.
- When work starts from someone's feedback, idea, bug report or pull request, note their name in the plan so the credit is not lost.
- If someone was left out, correct it openly in the next release notes.

## 6. Working in this codebase

- Load the matching skill before starting: `raven-ui` for anything a user sees, clicks or reads (also `RAVEN_UI_RULES.md`); `raven-media-engine` for audio, video, devices and calls. Both live in `.claude/skills/`. `raven-releases` (versions, builds, updates) exists only on the maintainer's machine.
- `docs/development.md` explains how to run the API and the desktop app; `docs/architecture.md` explains how the parts fit.
- No telemetry, analytics, tracking or third-party calls that reveal who talks to whom, when or for how long. A feature that sends data to another host is off by default or clearly opt-in, and its documentation says what is sent (link previews are the model).
- Server changes must keep working in the self-host bundle (`docs/self-hosting.md`) without any hosted service.
- Never commit, print or paste secrets: `.env`, `*.secret`, `*.dpapi`, updater keys and passwords.
