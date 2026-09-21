---
status: accepted
---

# Separate Project identity from the HTML content root

P0 treats a Project as an application-owned identity that points to a user-authorized canonical Content Root; `projectId` is not derived from the path, and opening an External Project does not write an identity marker into the user's source directory. The complete input and File Index contract is defined in [the HTML-first Project and Deck specification](../specs/html-first-project-deck-contract.md). This preserves stable application identity while allowing existing directories and keeps preview and Agent file access inside one explicit boundary.

The consequence is that P0 rejects ambiguous multi-entry Decks, out-of-root/reparse-point paths, and remote Resource dependencies. Supporting multiple Decks or a moved root requires a versioned migration decision rather than silently changing the meaning of existing Project and Annotation references.
