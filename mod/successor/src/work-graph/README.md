# Work graph experiment

Run:

```sh
bun test src/work-graph/work-graph.test.ts
bun src/work-graph/inspect.ts > paths.json
```

`paths.json` is the inspection format: each candidate contains node IDs, score components, and every step's original directed reference and provenance.

## Neutral fixture facts

- Launch Watchlist mentions its production deployment and launch material.
- Watchlist production mentions Gitea production as earlier work.
- One stable Gitea-production node is mentioned by Watchlist material, Platform notes, and the operational handbook.
- Platform mentions Platform notes; those notes mention Gitea and its deployment. No individual work item is labeled Platform.
- The handbook mentions backup verification. In a competing fixture, the schedule plugin instead keeps that handbook ID in private data.
- Drive Watchlist adoption mentions Watchlist and onboarding documentation.
- A weekly note co-mentions Watchlist, Gitea, launch, and onboarding documentation.

These are references and plugin ownership, not stored task/project/relation classifications.

## Experiments

| Experiment | Result | Implication |
| --- | --- | --- |
| Ordered `content: NodeId[]` plus backlinks | Represents shared Gitea work once and recovers Watchlist, Platform, and handbook contexts. | Sufficient as the default connective structure; no placement object is justified. |
| Undirected traversal over directed evidence | Finds context in either direction; output still says `forward`/`backward` and retains source, target, and array index. | Direction should be an indexing/query concern, not erased or converted into relation types. |
| Bounded simple-path enumeration | Handles cycles and duplicate references without repeated nodes or duplicate candidates and exposes alternatives. | Useful for small fixtures and inspection; exponential worst case means bounds are essential. |
| Hop-count ranking | Useful launch-to-deployment paths tie with the incidental two-hop weekly-note path. Tie-breaking is arbitrary. | One asserted shortest path is inadequate. Return candidates and evidence. |
| Query-time scoring | A 1.5 penalty per weekly-note-owned reference demotes incidental co-mentions. Direction-change and high-degree penalties are also explicit score components. | Provenance is needed for ranking, but semantic edge labels are not yet needed. Plugin/source identity can supply reversible interpretation. |
| Plugin-local schedule reference | `content` cannot traverse a handbook ID hidden in schedule data. An extractor returning only `{target, path}` restores the path and identifies its evidence. | Plugins need an optional minimal reference extractor if IDs may live in private data. It should disclose references, not global relation types. |
| Mutable names | Repointing `watchlist` resolves immediately to another stable node. | Direct name-to-node pointers satisfy this fixture; revisions add no demonstrated path value. |

The contextual score is deliberately modest rather than an ontology:

`hops + plugin/source provenance penalties + direction-change penalty + intermediate-node degree penalty`.

The output decomposes this score. The weekly-note penalty is fixture evidence that provenance matters, not a claim that all weekly notes are globally unimportant. Hub penalties are topology-derived and only affect intermediate nodes.

## Smallest adequate model

Keep the hypothesis nearly intact:

```ts
type Node = { id: string; plugin: string; data: unknown; content: string[] }
type Graph = { nodes: Map<string, Node>; names: Map<string, string> }
```

Foundational invariants are only unique/map-consistent stable IDs, resolvable stored references, and resolvable names. Preserve ordered repeated references; collapse them only in the traversal index while retaining all evidence. Add no revision split, placement entity, foundational work types, or relation labels now.

Outside storage, add:

1. an index of outgoing references, backlinks, and undirected adjacency;
2. an optional plugin extractor `(node) => { target, path }[]` for references in private data;
3. bounded candidate discovery, replaceable ranking, and evidence-preserving explanation.

## Rejected alternatives

- **Only one unweighted shortest path:** rejected by the weekly-note fixture; an incidental path ties useful paths.
- **Forward-only traversal:** rejected by Platform/handbook context, where explanatory movement naturally follows backlinks.
- **`content` as the only discoverable location:** conditionally rejected by the schedule-private-data fixture. It remains the preferred default.
- **Placement records:** rejected as unnecessary by the single Gitea-deployment node referenced from three contexts.
- **Stored relation taxonomy:** no fixture needs one. Source plugin and topology were enough to improve ranking.
- **Node/revision split:** no fixture exercises revision identity, so it adds complexity without observed value.

## Unresolved questions / next experiments

- Ask for examples where two references from the same source plugin have materially different meaning. If source/plugin provenance cannot rank them, test a minimal extractor-supplied provenance token before considering relation types.
- Add denser real notes to calibrate whether degree penalties help or suppress legitimate central concepts. Compare precision of top 3 paths with/without the penalty.
- Test temporal schedule evidence (overdue versus future) through a plugin-owned scoring feature, without storing a universal schedule role.
- Test edits/history that require links to an exact old state before adding revision-addressed nodes.
- Measure bounded enumeration on a larger personal fixture. If it becomes costly, retain the model and replace discovery with best-first/Yen-style candidate generation rather than redesigning storage.
- Evaluate whether ordered content position improves explanations; it is preserved as evidence but not currently scored.
