# Triage Labels

Record these roles in the local ticket's `Status:` line before work
is claimed. They are not remote repository labels.

| Canonical role | Local value | Meaning |
| --- | --- | --- |
| needs-triage | needs-triage | Maintainer needs to evaluate the request |
| needs-info | needs-info | Waiting for additional information |
| ready-for-agent | ready-for-agent | Fully specified and ready for an agent |
| ready-for-human | ready-for-human | Requires human implementation |
| wontfix | wontfix | Will not be actioned |

Triage applies to incoming raw requests. Tickets produced by
`/to-tickets` are already agent-ready and do not need another
triage pass.

Claiming, resolution, and dependency rules are defined in
`issue-tracker.md`.
