# SHppt

SHppt is a local, HTML-first presentation editor. Its domain is a user-authorized HTML project that can be previewed as a Deck, marked visually, and changed through a controlled AgentRun.

## Project and Deck

**Project**:
A durable application identity for one user-authorized Content Root and its metadata.
_Avoid_: workspace, folder, directory when referring to the identity.

**Content Root**:
The canonical directory that contains a Project's source files and resources. Every Project-relative Path is resolved within this boundary.
_Avoid_: project path when the domain meaning is the authorized content boundary.

**External Project**:
A Project whose Content Root was selected from an existing user directory rather than created by SHppt.
_Avoid_: imported project when no copy of the source files was made.

**Deck**:
The navigable presentation discovered from a Project's Entry Document. In P0, one Project exposes one active Deck.
_Avoid_: PPTX when referring to the HTML source presentation.

**Entry Document**:
The HTML document that defines a Deck's Slide roots and links its local resources.
_Avoid_: entry point when the domain object, rather than a runtime process, is meant.

**Slide**:
A navigable rectangular presentation canvas identified by a stable Slide ID inside the Entry Document.
_Avoid_: page when distinguishing a presentation canvas from an arbitrary HTML page.

**Resource**:
A local file referenced by an Entry Document or its stylesheets, such as CSS, JavaScript, image, media, or font content.
_Avoid_: asset when the file is part of the Project's source contract.

**File Index**:
The Project-relative inventory shared by preview, Annotation, and AgentRun so that all three use the same file and resource identity.
_Avoid_: file tree when the semantic inventory, rather than a navigation widget, is meant.

**Project-relative Path**:
A slash-separated path relative to the Content Root; it is the only path form used by browser-facing and Agent-facing contracts.
_Avoid_: absolute path in external messages.

## Stable Marking Terms

**Stable Element ID**:
The author-owned `data-od-id` value that identifies a markable DOM element across cosmetic changes and ArtifactVersions.
_Avoid_: selector or generated element ID as the element's durable identity.

**Slide ID**:
The author-owned `data-od-slide` value that identifies a Slide across navigation and ArtifactVersions.
_Avoid_: slide index as the durable identity; an index is only the current document-order position.

**Annotation**:
A saved user mark containing intent, visual evidence, and the available structural location of a Slide or Stable Element ID.

**AgentRun**:
One controlled Agent task associated with a saved Annotation and a specific ArtifactVersion.

**Project Session**:
The durable conversation context that may connect multiple AgentRuns for one Project and one Agent provider. It is not the Claude CLI process itself; its provider session identity can be replaced only through an explicit new-session decision.

**Turn**:
One model interaction inside an AgentRun. A Turn has its own streamed events and terminal result; in P0, one AgentRun contains exactly one Turn.

**Hard Scope**:
The explicit Slide, Stable Element ID, Project-relative Path, and change-kind boundary an AgentRun is allowed to use. A user note cannot widen a Hard Scope.

**ArtifactVersion**:
A reviewable source-file state associated with a Project change, including enough before/after evidence to inspect or restore it.
