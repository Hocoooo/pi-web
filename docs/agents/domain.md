# Domain Docs

This repo uses a single domain-documentation context:
root `GLOSSARY.md` and the existing `docs/adr/`.

## Reading order

1. Follow the existing requirement to read
   `docs/branch-features/README.md` and affected feature contracts first.
2. Read root `GLOSSARY.md` when it exists.
3. Read ADRs relevant to the area being explored or changed.
4. Read the relevant topic notes under `docs/agents/`.

A missing glossary is not a setup error. Proceed without creating
an empty file; create it when the first domain term is resolved.

## Vocabulary

Use established glossary terms consistently in designs, tickets,
code discussions, and tests.

Keep `GLOSSARY.md` limited to domain vocabulary and relationships.
Implementation plans and technology choices belong elsewhere.

When a term conflicts with the glossary, resolve its meaning
explicitly before changing the definition.

## Decisions and contracts

Preserve the existing ADRs and continue their numbering when a new
decision warrants an ADR. Check the current directory before
choosing the next number.

Record an ADR for decisions that are hard to reverse, surprising
without context, and the result of a real trade-off.

Surface conflicts with existing ADRs or feature contracts rather
than silently overriding them.

Research and proposals are not approved decisions or implemented
behavior. Continue maintaining feature contracts alongside
implementation changes.
