# FABLE_ARCHITECT_BRIEF.md

# Principal Architecture Commission

## Context

You are not being asked to implement this project.

You are being asked to design it.

Treat this exactly as a Principal Engineer or Distinguished Architect would treat the early stages of a large engineering initiative.

Your job is to challenge assumptions, identify risks, propose better ideas, and produce an architecture that can be executed by a team of implementation engineers.

The implementation will almost certainly be delegated to many smaller coding agents. Your responsibility is to make that delegation possible.

Assume your design documents will become the foundation of this project.

Quality matters far more than speed.

---

# Read First

Before beginning, read the accompanying `PROJECT_CHARTER.md`.

That document defines the philosophy of the project.

If you disagree with any aspect of the charter, challenge it.

Do not silently work around assumptions you believe are flawed.

Part of your responsibility is improving the vision itself.

---

# The Problem

Current agentic development tools focus almost entirely on execution.

They answer questions like:

* How do we launch an agent?
* How do we execute code?
* How do we call an LLM?

Those are implementation concerns.

The harder problem appears after an organisation begins using dozens of persistent AI specialists.

Questions become organisational rather than technical.

For example:

How do I know what every agent is currently doing?

How do I know why it is doing it?

How do I know who delegated work to whom?

How do I supervise long-running work?

How do I communicate with one specific specialist?

How do specialists collaborate?

How do specialists review one another?

How do specialists remain persistent across weeks or months?

How do I understand an organisation rather than a collection of terminal sessions?

This project exists to answer those questions.

---

# Existing Inspiration

There are excellent tools that solve parts of this problem.

Examples include:

* Claude Code
* Codex CLI
* Gemini CLI
* Claude Desktop
* Cursor
* Continue
* Damon ADE
* Kubernetes
* Linear
* GitHub
* Slack

Study ideas from all of them.

Do not imitate any of them.

The goal is not another IDE.

The goal is not another terminal wrapper.

The goal is an operating environment for AI organisations.

---

# Important Philosophy

Claude Code already executes work extremely well.

Codex already executes work extremely well.

Future tools will execute work even better.

This project should avoid competing with execution engines.

Instead, it should orchestrate them.

Execution engines should be treated like interchangeable workers underneath a stable control plane.

The architecture should make replacing Claude Code with another engine relatively straightforward.

---

# The Mental Model

Think less like an IDE designer.

Think more like someone designing:

* Kubernetes
* Mission Control
* Air Traffic Control
* A Network Operations Centre
* An Engineering Organisation
* A Company Org Chart

Humans are not opening files.

Humans are supervising specialists.

---

# The User Experience

Imagine opening the application every morning.

Instead of seeing editor tabs, imagine seeing an organisation.

Examples:

Backend Team

Frontend Team

Platform Team

Documentation Team

Research Team

Architecture Team

Each contains persistent specialists.

Each specialist has:

* identity
* role
* expertise
* current status
* active conversations
* delegated work
* health
* execution engine
* memory
* instructions

Clicking an agent should allow me to:

* open an existing conversation
* start a new conversation
* inspect its history
* inspect delegated work
* inspect spawned sub-agents
* inspect reasoning summaries
* inspect progress
* inspect artifacts

Agents are the primary navigation object.

Not files.

---

# Long-Lived Agents

An agent should not disappear because a terminal closes.

Agents are persistent.

Conversations are disposable.

An Orbit Backend Engineer today should still be the Orbit Backend Engineer six months from now.

It should simply have many completed conversations.

---

# Multiple Conversations

One agent may have many conversations simultaneously.

For example:

Orbit Backend Engineer

├── Feature Planning

├── Authentication Refactor

├── Bug #482

├── Production Investigation

└── Architecture Discussion

The architecture should support this naturally.

---

# Delegation

Delegation is a first-class concept.

If an agent delegates work:

the human should immediately understand:

who delegated

who received the work

current status

dependencies

progress

results

No work should become invisible.

---

# Agent Hierarchies

Sub-agents should form trees.

Example

Architecture Agent

├── Backend Agent

│ ├── Authentication Agent

│ ├── API Agent

│ └── Testing Agent

├── Frontend Agent

└── Documentation Agent

The hierarchy should always remain observable.

---

# Communication

One capability I believe is currently missing from most systems is communication.

Do not assume agents only communicate through the human.

Explore architectures where agents can:

request reviews

ask questions

propose alternatives

challenge assumptions

handover work

report completion

escalate blockers

share discoveries

while keeping the human informed.

Do not simply build chat.

Design communication.

---

# Observability

This may be the single most important requirement.

Current agent spawning often reduces visibility.

I want the opposite.

I should understand an organisation at a glance.

Examples include:

who is active

who is idle

who is blocked

who is waiting

who is reviewing

who is delegating

who is overloaded

who is spawning additional workers

who is consuming unusual resources

The environment should expose organisational health.

---

# Cognitive Load

Do not optimise for maximum information.

Optimise for maximum understanding.

The interface should reduce cognitive load rather than increase it.

Challenge dashboard conventions if necessary.

---

# Think In Layers

I suspect this system naturally decomposes into layers.

For example:

Control Plane

Organisation Layer

Agent Runtime

Execution Providers

Persistence

Communication

Scheduling

Memory

Telemetry

UI

Do not feel constrained by this.

If you discover a better decomposition, use it.

---

# Challenge Everything

Do not assume my ideas are correct.

If a concept is flawed:

say so.

If a concept should be removed:

remove it.

If there is a more elegant abstraction:

prefer it.

If there is unnecessary complexity:

eliminate it.

Your responsibility is not agreement.

Your responsibility is good architecture.

---

# Deliverables

I expect architecture documents rather than code.

At minimum I would like:

* Executive Summary
* Design Philosophy
* System Vision
* Core Concepts
* Domain Model
* Agent Lifecycle
* Communication Architecture
* Delegation Model
* Organisation Model
* Control Plane Design
* Runtime Architecture
* Data Model
* Persistence Strategy
* UI Philosophy
* Observability Architecture
* Security Considerations
* Failure Modes
* Scalability Strategy
* Plugin Architecture
* Technology Recommendations
* Open Questions
* Risks
* Trade-offs
* Future Evolution

---

# After The Architecture

Once the design is complete:

act as a Technical Lead.

Break the architecture into implementation work.

Produce:

Epics

Stories

Technical Tasks

Acceptance Criteria

Architecture Decision Records

Suggested Repository Structure

Component Contracts

API Contracts

Data Contracts

Suggested Testing Strategy

Dependency Graph

Implementation Order

Every task should be sufficiently isolated that it could reasonably be delegated to a Haiku-level coding agent with minimal additional reasoning.

The architecture should maximise parallel implementation.

---

# What Success Looks Like

I should finish reading your documents and feel:

"I understand exactly what we're building."

"I understand why it's designed this way."

"I understand the trade-offs."

"I could hand this to a team tomorrow."

"I trust the architecture."

Only after that should implementation begin.

Do not write production code.

Design the system that will make writing production code straightforward.

Think deeply.

Challenge assumptions.

Optimise for the next decade rather than the next demo.

The architecture is the product of this exercise.
