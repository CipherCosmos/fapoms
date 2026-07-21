
# Part 2 — Domain Model Specification

## Field Audit Planning & Operations Management System (FAPOMS)

Version: 1.0

---

# 1. Domain Overview

The system consists of several business entities that represent real-world objects involved in audit planning and execution.

Each entity has:

* A clear business purpose.
* A defined lifecycle.
* Relationships with other entities.
* Ownership rules.
* Operational constraints.

The platform should model the business rather than the current Excel sheets.

---

# 2. Client

## Purpose

Represents an organization that requests field audits.

Examples:

* Axis Bank
* ICICI Bank
* RBL Bank

A Client owns multiple Projects.

### Business Rules

* One Client can have many Projects.
* Projects from different Clients are completely independent.
* Client-specific data formats must not affect the internal platform model.

---

# 3. Project

## Purpose

Represents one audit request received from a Client.

A Project is the primary operational container for planning and execution.

A Project contains:

* Multiple Branches
* Multiple Schedules
* Multiple Assignments

### Lifecycle

Draft

↓

Planning

↓

Scheduling

↓

Execution

↓

Validation

↓

Completed

↓

Archived

### Business Rules

* Belongs to exactly one Client.
* Usually completed within one monthly operational cycle.
* Can be paused (rare).
* Can have priority.
* Multiple Projects may exist simultaneously.

---

# 4. Branch

## Purpose

Represents a bank branch requiring an audit.

A Branch is a physical location.

### Business Rules

* A Branch may appear in many Projects over time.
* Each appearance is a new audit requirement.
* Historical audit records must never be overwritten.

### Important Principle

A Branch is a permanent business entity.

Its participation in a Project is temporary.

---

# 5. Project Branch

## Purpose

Represents the occurrence of a Branch inside a specific Project.

This entity exists because:

One Branch

↓

Many Projects

Each occurrence has:

* Different audit
* Different schedule
* Different Assayer
* Different status

Without this entity, history cannot be maintained correctly.

---

# 6. Assayer

## Purpose

Represents an external field auditor.

The Assayer is one of the most important entities in the platform.

### Characteristics

An Assayer:

* Lives in one primary state.
* Can perform multiple assignments.
* May work for multiple Clients.
* May reject assignments.
* Has no formal rating system.

### Long-Term Information

The platform should gradually build:

* Assignment history
* Coverage history
* Fee history
* Performance statistics

---

# 7. Schedule

## Purpose

Represents the agreed audit date.

Scheduling occurs after:

* Assayer discussion
* Availability confirmation

Scheduling occurs before:

* Customer data download
* PDF generation

### Business Rules

One Schedule belongs to:

* One Project
* One Branch
* One Assayer

---

# 8. Assignment

## Purpose

Represents the commitment between the company and an Assayer to perform one audit.

This entity records:

Who

Will audit

Which Branch

On Which Date

### Lifecycle

Pending

↓

Contacted

↓

Negotiating

↓

Accepted

↓

Scheduled

↓

Audit Completed

↓

Closed

Possible alternative path:

Rejected

↓

Find another Assayer

### Business Rules

Once Accepted:

The Assignment becomes operationally locked.

Reassignment should occur only under exceptional circumstances.

---

# 9. Zone

## Purpose

Represents an operational grouping created for planning convenience.

Zones help distribute workload among Operations Team members.

### Important

Zones are NOT:

* Administrative regions
* Permission boundaries
* Security boundaries

They are simply operational planning groups.

Zones should remain configurable.

---

# 10. Holiday

## Purpose

Represents dates when audits should not normally be scheduled.

Examples:

* National holidays
* Bank holidays

The Scheduling Engine should automatically consider these dates.

---

# 11. User

## Purpose

Represents an internal employee using the platform.

Examples:

* Operations
* Validation
* Data Entry
* HR
* Management

Users belong to departments.

Permissions are defined later.

---

# 12. Document

Represents business files exchanged during the workflow.

Examples:

* Branch list
* Customer master data
* Generated PDF
* Returned audit PDF
* Generated Excel
* Final report

Documents move between departments according to the workflow.

---

# 13. Communication

Represents interactions related to assignments.

Examples:

* Phone discussion
* WhatsApp dispatch
* Email communication

Initially, the system may simply log important communication events rather than replace existing communication channels.

---

# 14. Travel

Represents operational travel associated with an Assignment.

Travel includes:

* Estimated distance
* Estimated travel cost
* Travel mode
* Operational planning information

Travel reimbursement is independent of the Assayer's professional fee.

---

# 15. Coverage

Coverage is a calculated business metric.

Coverage indicates:

Assigned Branches

÷

Total Project Branches

Coverage is measured at multiple levels:

* Project
* Zone
* State
* Client

---

# 16. Relationship Model

```text
Client
│
└── Project
      │
      ├── Project Branch
      │        │
      │        └── Branch
      │
      ├── Schedule
      │
      ├── Assignment
      │
      └── Documents

Assignment
│
├── Assayer
├── Travel
├── Communication
└── Schedule

User
│
└── Department

Holiday

Zone
```

---

# 17. Business Ownership

Client

owns

Projects

Project

owns

Project Branchs
Schedules
Assignments
Documents

Branch

is shared across Projects.

Assayer

is shared across Projects.

Holiday

is global.

Zone

is configurable.

---

# 18. Fundamental Design Principles

## Principle 1

Historical information is never overwritten.

Every audit must remain traceable.

---

## Principle 2

Planning and execution are different phases.

Scheduling creates the plan.

Assignments execute the plan.

---

## Principle 3

Branch is permanent.

Project Branch is temporary.

---

## Principle 4

An accepted Assignment should not normally be changed.

Relationship management is more important than small operational savings.

---

## Principle 5

The platform recommends.

Humans decide.

---

## Principle 6

Client-specific data should be normalized into a common internal business model before entering operational workflows.

---

# 19. Domain Boundaries

Inside this platform:

* Planning
* Scheduling
* Assignment
* Tracking
* Coordination
* Reporting

Outside this platform:

* Banking systems
* Customer account processing
* OCR engine implementation
* PDF rendering implementation
* Financial accounting
* Payroll
* External communication providers

The platform integrates with these systems but does not replace them.
