# PROJECT_CHARTER.md

# Build Organisations, Not Automations

> *"The future isn't one increasingly intelligent AI. It's an organisation of specialised intelligences working together under human leadership."*

---

# Purpose

This project exists to explore a different future for AI-assisted software development.

Most AI tooling today focuses on making a single assistant increasingly capable. Better reasoning. Larger context windows. More autonomous execution.

This project starts from a different assumption.

As models become more capable, we will increasingly rely on **multiple specialised agents** rather than one general-purpose assistant.

The challenge therefore shifts.

The limiting factor is no longer model intelligence.

The limiting factor becomes **organisation**.

How do humans effectively supervise dozens or hundreds of AI specialists?

How do those specialists collaborate?

How do they communicate?

How do they delegate?

How do they remain understandable?

How do they remain trustworthy?

This project exists to answer those questions.

---

# Vision

We are not building another AI-powered IDE.

We are not building another chatbot.

We are building the operating environment for persistent AI collaborators.

The environment should make supervising a growing organisation of AI specialists feel as natural as leading a high-performing engineering team.

Agents should feel less like subprocesses and more like colleagues.

They should have identities.

Responsibilities.

History.

Memory.

Relationships.

Conversations.

Specialisations.

The human should not manage prompts.

The human should lead an organisation.

---

# The Core Question

Whenever a design decision is difficult, return to this question:

> **Does this make it easier for a human to lead an organisation of persistent AI specialists?**

If the answer is no, it probably belongs somewhere else.

---

# The Mental Model

The primary abstraction is **the agent**.

Not the terminal.

Not the editor.

Not the conversation.

Not the model.

Everything else exists to support the lifecycle of persistent agents.

An agent is not a prompt.

An agent is not a process.

An agent is not a terminal session.

An agent is a persistent specialist.

Conversations are workstreams.

Terminals are execution environments.

Models are interchangeable execution engines.

The agent remains.

---

# Core Principles

## 1. Agents Are First-Class Citizens

The system is built around persistent agents.

Everything else is secondary.

Agents own:

* Identity
* Purpose
* Expertise
* Instructions
* Memory
* Responsibilities
* Conversations
* Relationships
* Current objectives

Deleting a conversation must never delete an agent.

Restarting a terminal must never destroy an agent's identity.

Changing execution engines must never fundamentally change an agent.

---

## 2. Conversations Are Workstreams

A conversation is simply one thread of work.

A single agent may have many conversations.

Example:

Orbit Backend Engineer

* Authentication Refactor
* Bug #431
* Architecture Review
* Planning
* Production Incident

These are conversations.

Not agents.

The identity persists.

The workstreams come and go.

---

## 3. Observability Before Automation

Automation without visibility reduces trust.

The objective is not maximum autonomy.

The objective is informed delegation.

Humans should understand:

* what an agent is doing
* why it is doing it
* whether it is blocked
* what assumptions it has made
* what decisions it has taken
* what confidence it has
* who it is collaborating with

without needing to inspect every token generated.

The environment should expose telemetry, not noise.

---

## 4. Humans Remain Responsible

The system exists to increase human leverage.

Not replace human judgement.

Agents should:

* explain
* justify
* escalate
* recommend
* collaborate

Humans should:

* prioritise
* approve
* redirect
* mentor
* decide

Authority ultimately rests with the human.

---

## 5. Delegation Is Visible

Delegation should never reduce visibility.

If an agent delegates work:

the human should understand:

* why
* to whom
* current progress
* blockers
* expected outcome
* relationship to the parent task

Delegation should increase transparency.

Not hide work.

---

## 6. Collaboration Is A Capability

The intelligence of the organisation matters more than the intelligence of any single model.

Agents should eventually be capable of:

* requesting reviews
* asking questions
* proposing ideas
* debating designs
* reviewing code
* challenging assumptions
* escalating concerns

The organisation should become more capable than the sum of its individual agents.

---

## 7. Organisation Over Autonomy

A hundred autonomous agents without structure create chaos.

A well-organised team consistently outperforms isolated brilliance.

This project optimises for:

coordination

clarity

ownership

communication

responsibility

rather than simply increasing autonomy.

---

## 8. The Control Plane Is The Product

Claude Code is not the product.

Codex is not the product.

Gemini CLI is not the product.

Future models are not the product.

Execution engines are replaceable.

The product is the environment that organises them.

Execution belongs underneath the control plane.

Never inside it.

---

## 9. Design For Replacement

Everything should assume replacement.

Models.

Execution engines.

Storage.

Memory.

Protocols.

Providers.

No architectural decision should unnecessarily bind the system to a specific vendor or model.

---

## 10. Design For Delegation

Every architectural decision should make implementation easier to delegate.

Large systems should naturally decompose into:

Epics

Stories

Tasks

with clear contracts between components.

Small implementation agents should be capable of contributing independently.

The architecture should optimise for parallel development.

---

## 11. Trust Through Understanding

Trust should emerge from understanding.

Not blind faith.

The system should make it easy to answer:

Why did this happen?

Who made this decision?

What information was available?

What alternatives were considered?

Who approved it?

Trust grows through explainability.

---

# Design Philosophy

The environment should feel closer to:

an engineering organisation

than

an IDE.

It should borrow ideas from:

* Engineering management
* Organisational design
* Mission control
* Distributed systems
* Kubernetes
* Git
* Slack
* Linear

rather than traditional editor design.

---

# What We Are Explicitly Not Building

We are not building:

* another chatbot
* another IDE
* another prompt manager
* another terminal multiplexer
* another workflow automation platform
* another agent launcher
* another wrapper around Claude Code

Those tools may exist inside the environment.

They are not the environment itself.

---

# Engineering Principles

Every subsystem should strive to be:

Simple.

Composable.

Observable.

Replaceable.

Loosely coupled.

Highly cohesive.

Explicit.

Predictable.

Inspectable.

Testable.

---

# Success Looks Like

The project succeeds when:

Managing fifty AI specialists feels natural.

Delegation increases confidence.

Not anxiety.

Long-running work remains understandable.

Humans supervise.

Agents execute.

Knowledge compounds over time.

Agent identities persist for months or years.

Replacing an execution engine requires minimal architectural change.

The environment scales because organisation scales.

Not because individual models become larger.

---

# Future Vision

One day this environment should support organisations that contain hundreds of specialised agents.

Some may write software.

Others may perform research.

Others may analyse finances.

Others may prepare presentations.

Others may coordinate projects.

Others may review architecture.

Others may mentor newer agents.

The exact domains are unimportant.

The organisational model is.

This project is ultimately an exploration into how humans and persistent AI specialists can work together effectively.

The goal is not to build smarter agents.

The goal is to build a better organisation.

---

# Decision Framework

Before implementing any feature, ask:

Does this strengthen the organisation?

Does this improve observability?

Does this preserve human oversight?

Does this reduce cognitive load?

Does this improve collaboration?

Does this increase trust?

Does this make future delegation easier?

If most answers are "no", reconsider the design.

---

# Final Thought

Every generation of software has had a primary abstraction.

Operating systems managed processes.

GitHub manages repositories.

Kubernetes manages containers.

This project explores whether the next abstraction is the **persistent AI specialist**.

If that proves true, then our responsibility is not to build another development tool.

It is to build the environment where those specialists can thrive.

---

*"Build organisations, not automations."*
