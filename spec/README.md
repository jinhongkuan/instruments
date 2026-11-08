# Specifications

Executable [Quint](https://quint-lang.org) models of the parts of this system where a wrong invariant costs money: position reconstruction, carry accrual, and later the data aggregation and real-time analytics pipelines.

Workflow, following the `quint-llm-kit` skills:

1. `quint typecheck <file>` after every change.
2. `quint run <file> --main <instance> --invariant <name>` to sample traces. Never `quint verify` unless explicitly asked; it is bounded model checking and takes minutes to hours.
3. Tests (`run` definitions) live in `*_test.qnt` files that import the spec.

`./spec/run.sh` runs typecheck and the sampled invariants for every spec.

| Spec | Models | Status |
|---|---|---|
| `carry.qnt` | FIFO lot ledger with floating vs. fixed carry accrual | skeleton |
| `aggregation.qnt` | ingestion checkpoints, idempotent upserts, gap handling | planned |
| `analytics.qnt` | incremental refresh of per-address results on new fills | planned |
