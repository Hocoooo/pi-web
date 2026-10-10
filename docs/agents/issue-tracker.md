# Issue tracker: Local Markdown

Specs and tickets live under `.scratch/<feature-slug>/`.
Tracker operations are local filesystem operations.

## File conventions

- Spec: `.scratch/<feature-slug>/spec.md`.
- Tickets: `.scratch/<feature-slug>/issues/<NN>-<slug>.md`,
  numbered from `01`, one file per ticket.
- Ticket numbers are unique within a feature directory.
  Cross-feature references must include the file path.
- Record triage state with a `Status:` line near the top;
  use the roles in `triage-labels.md`.
- Append comments under `## Comments`; preserve prior discussion.
- Create directories and files when needed, not as empty scaffolding.

## Skill operation mapping

- "Publish to the issue tracker": create or update the local Markdown file.
- "Fetch the relevant ticket": read the referenced file.
- "Comment": append under `## Comments`.
- "Apply a triage label": update the local `Status:` line.
- "Claim": set `Status: claimed` and save before starting work.
- "Resolve": record the outcome and validation, then set `Status: resolved`.
- Failed tests, partial implementation, or unresolved blockers leave the
  ticket unresolved. Record the blocker and remaining work.

Triage roles describe readiness before work is claimed.
`claimed` and `resolved` describe execution progress.

## Blocking and ready work

- Record dependencies as `Blocked by: 01, 02`, or `Blocked by: none`.
- Numbers refer to tickets in the same feature directory.
- A ticket is unblocked only when all referenced tickets are `resolved`.
- Missing dependencies remain blockers; report them.
- For implementation, choose unclaimed `ready-for-agent` tickets with
  no unresolved blockers, in ticket-number order.
- A `wontfix` ticket does not automatically satisfy a dependency;
  revise the dependent ticket explicitly.

## Wayfinding

- Map: `.scratch/<effort>/map.md`.
- Decision tickets: `.scratch/<effort>/issues/<NN>-<slug>.md`.
- Record `Type: research`, `prototype`, `grilling`, or `task`.
- Select open, unclaimed decision tickets whose blockers are resolved.
- Claim before work. On resolution, append an `## Answer`, set
  `Status: resolved`, and update the map's Decisions-so-far.
- Context pointers use local paths and relevant document headings.

## Local-only policy

Do not create remote issues, labels, or Gists for this workflow.
Do not automatically commit or push `.scratch/` artifacts.
Remote publication requires explicit user approval.
