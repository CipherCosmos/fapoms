
# Part 6 — Business State & Event Model

## Field Audit Planning & Operations Management System (FAPOMS)

Version: 1.0

---

# 1. Purpose

The platform manages long-running business processes.

Every important business entity progresses through a well-defined lifecycle.

Business events trigger transitions between states.

State transitions must be consistent across all modules.

---

# 2. Design Principles

* Every entity has one current state.
* State transitions are controlled by business rules.
* Invalid transitions are prohibited.
* Every state change generates a business event.
* State history is immutable and auditable.

---

# 3. Project Lifecycle

```text
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
```

Exceptional transitions:

* Planning → Cancelled
* Scheduling → On Hold
* Execution → On Hold

### Business Events

* Project Created
* Planning Started
* Scheduling Started
* Execution Started
* Validation Started
* Project Completed
* Project Archived
* Project Cancelled

---

# 4. Project Branch Lifecycle

Each Project Branch represents one branch within one project.

Lifecycle:

```text
Imported
    ↓
Planning
    ↓
Assignment Confirmed
    ↓
Scheduled
    ↓
Audit Completed
    ↓
Validation Completed
    ↓
Closed
```

Alternative path:

```text
Planning
    ↓
Unable To Cover
```

Business Events:

* Branch Imported
* Candidate Selected
* Assignment Confirmed
* Audit Scheduled
* Audit Completed
* Validation Completed
* Branch Closed
* Coverage Failed

---

# 5. Assignment Lifecycle

```text
Created
    ↓
Candidate Selected
    ↓
Contact Initiated
    ↓
Negotiation
    ↓
Accepted
    ↓
Scheduled
    ↓
Audit Completed
    ↓
Closed
```

Alternative paths:

```text
Negotiation
    ↓
Rejected

Accepted
    ↓
Cancelled (Emergency Only)
```

### Rules

Once Accepted:

* Assignment becomes operationally committed.
* Reassignment requires cancellation first.

Business Events:

* Assignment Created
* Candidate Contacted
* Negotiation Started
* Assignment Accepted
* Assignment Rejected
* Assignment Cancelled
* Audit Completed
* Assignment Closed

---

# 6. Schedule Lifecycle

```text
Tentative
    ↓
Confirmed
    ↓
Completed
```

Alternative:

```text
Confirmed
    ↓
Rescheduled
```

Business Events:

* Schedule Proposed
* Schedule Confirmed
* Schedule Rescheduled
* Schedule Completed

---

# 7. Document Lifecycle

```text
Uploaded
    ↓
Processed
    ↓
Generated
    ↓
Dispatched
    ↓
Received
    ↓
Archived
```

Each document version must remain traceable.

Business Events:

* Document Uploaded
* PDF Generated
* PDF Sent
* Audit Returned
* Report Generated
* Final Report Submitted

---

# 8. Validation Lifecycle

```text
Pending
    ↓
Assigned
    ↓
OCR Processing
    ↓
Human Review
    ↓
Approved
    ↓
Submitted
```

Alternative:

```text
Human Review
    ↓
Correction Required
```

Business Events:

* Validation Started
* OCR Completed
* Review Completed
* Correction Requested
* Validation Approved
* Submitted To Client

---

# 9. Assayer Lifecycle

```text
Registered
    ↓
Active
    ↓
Inactive
```

Temporary states:

* Busy
* Suspended

Business Events:

* Assayer Registered
* Activated
* Deactivated
* Profile Updated

---

# 10. Business Event Categories

The platform should classify events into:

### Operational Events

Examples:

* Assignment Accepted
* Audit Completed
* Project Closed

---

### User Events

Examples:

* Login
* Profile Updated
* Password Changed

---

### Workflow Events

Examples:

* Validation Started
* OCR Completed
* Report Submitted

---

### System Events

Examples:

* Background Job Finished
* Import Completed
* Notification Delivered

---

# 11. Event Characteristics

Every business event should contain:

* Event Type
* Event Time
* Initiating User or System
* Related Entity
* Previous State
* New State
* Optional Remarks

This enables complete operational auditing.

---

# 12. State Transition Rules

General rules:

* States move forward through the lifecycle.
* Backward transitions are restricted.
* Exceptional transitions require explicit business justification.
* Every transition is recorded permanently.

---

# 13. Audit Trail

The system must preserve:

* Who performed the action.
* When it occurred.
* What changed.
* Why it changed (if applicable).

Business history must never be overwritten.

---

# 14. Design Philosophy

The platform should behave as a state-driven system.

Business Services change entity states.

Business Events record those changes.

Analytics, notifications, dashboards, and audit logs consume those events.

This creates a single source of truth for operational behavior while keeping every module synchronized.
