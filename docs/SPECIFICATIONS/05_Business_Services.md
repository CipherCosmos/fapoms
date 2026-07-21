
# Part 5 — Business Services Specification

## Field Audit Planning & Operations Management System (FAPOMS)

Version: 1.0

---

# 1. Purpose

Business Services implement the business capabilities of the platform.

They contain the operational logic and business rules.

Business Services:

* Receive business requests.
* Apply business rules.
* Coordinate domain entities.
* Produce business outcomes.

They do **not** contain UI logic or database-specific logic.

---

# 2. Design Principles

Every Business Service should:

* Own one business capability.
* Be reusable by multiple modules.
* Be independently testable.
* Avoid duplicate logic.
* Produce auditable business events.
* Remain independent of client-specific formats.

---

# 3. Project Service

## Purpose

Manage the lifecycle of Projects.

### Responsibilities

* Create Project
* Update Project
* Close Project
* Archive Project
* Track Project Progress
* Calculate Project Statistics

### Business Rules

* Every Project belongs to one Client.
* A Project cannot be deleted after planning begins.
* Archived Projects remain searchable.

---

# 4. Branch Service

## Purpose

Manage branch master information.

### Responsibilities

* Normalize imported branch data.
* Detect existing branches.
* Create new branches.
* Update branch information.
* Maintain geographic information.

### Business Rules

A Branch is a permanent entity.

Projects reference Branches rather than creating duplicates.

---

# 5. Assayer Service

## Purpose

Manage the organization's field workforce.

### Responsibilities

* Register Assayers.
* Update profiles.
* Activate/Deactivate Assayers.
* Track assignment history.
* Maintain operational availability.

### Business Rules

An Assayer:

* Can belong to one primary state.
* Can participate in multiple Projects.
* Can have multiple Assignments.
* Must remain historically traceable.

---

# 6. Candidate Recommendation Service

## Purpose

Identify suitable Assayers for every Branch.

This service assists Operations during planning.

It never performs automatic assignment.

### Inputs

* Branch
* Geographic information
* Existing Assignments
* Operational rules

### Outputs

Ranked list of candidate Assayers.

### Business Rules

Recommendations are based only on information known before contacting the Assayer.

The service must **not** consider:

* Negotiated fee
* Final audit date

because those values do not yet exist.

---

# 7. Coverage Service

## Purpose

Measure project execution readiness.

### Responsibilities

* Calculate coverage.
* Identify uncovered branches.
* Measure zone coverage.
* Measure state coverage.
* Estimate remaining work.

### Outputs

Examples:

* 95% Coverage
* 5 Remaining Branches
* 3 Districts without nearby Assayers

Coverage updates continuously during planning.

---

# 8. Scheduling Service

## Purpose

Validate and record agreed audit dates.

Scheduling occurs only after an Assayer accepts the assignment.

### Responsibilities

* Validate calendar.
* Check holidays.
* Prevent scheduling conflicts.
* Maintain audit calendar.

### Business Rules

The Scheduling Service never chooses an Assayer.

Its responsibility begins only after the Assignment decision has been made.

---

# 9. Assignment Service

## Purpose

Manage the complete lifecycle of Assignments.

### Responsibilities

* Create Assignment.
* Track negotiation.
* Confirm acceptance.
* Record rejection.
* Close Assignment.
* Record cancellation.

### Business Rules

Accepted Assignments are operational commitments.

Normal reassignment is prohibited.

Exceptional reassignment requires explicit cancellation before a new Assignment is created.

---

# 10. Geographic Service

## Purpose

Provide geographic intelligence.

### Responsibilities

* Calculate distance.
* Find nearby Assayers.
* Cluster Branches.
* Support route estimation.
* Support coverage analysis.

This service provides geographic calculations only.

Business decisions remain with higher-level services.

---

# 11. Holiday Service

## Purpose

Provide working-day validation.

### Responsibilities

* National Holidays
* Bank Holidays
* Future configurable holiday calendars

Other services query this service when validating schedules.

---

# 12. Communication Service

## Purpose

Maintain operational communication history.

Initially the platform records communication events.

It does not replace:

* Phone
* WhatsApp
* Email

### Responsibilities

Record events such as:

* Contact initiated
* Accepted
* Rejected
* Reminder sent
* PDF dispatched

---

# 13. Document Service

## Purpose

Track business documents throughout the workflow.

### Responsibilities

* Receive documents
* Version documents
* Track movement
* Record ownership
* Preserve history

The service tracks documents regardless of file format.

---

# 14. Workflow Service

## Purpose

Coordinate movement between departments.

This service ensures business processes occur in the correct order.

Example:

Planning

↓

Scheduling

↓

Customer Data

↓

PDF Generation

↓

Audit

↓

Validation

↓

OCR

↓

Review

↓

Submission

The Workflow Service prevents invalid transitions.

---

# 15. Notification Service

## Purpose

Notify internal users about important operational events.

Examples:

* Project Created
* Assignment Accepted
* Project Completed
* Validation Pending

Communication channels may expand in future versions.

---

# 16. Analytics Service

## Purpose

Generate operational insights.

Examples include:

* Coverage Trends
* Assignment Statistics
* Project Performance
* Operational Workload
* State-wise Distribution
* Assayer Utilization

Analytics should operate on historical data without affecting operational workflows.

---

# 17. Service Interaction Overview

```text
Project Service
        │
        ▼
Branch Service
        │
        ▼
Candidate Recommendation Service
        │
        ▼
Assignment Service
        │
        ▼
Scheduling Service
        │
        ▼
Workflow Service
        │
        ├────────────► Document Service
        │
        ├────────────► Communication Service
        │
        ├────────────► Notification Service
        │
        └────────────► Analytics Service

Geographic Service
        ▲
        │
Coverage Service
        ▲
        │
Holiday Service
```

---

# 18. Guiding Principle

Business Services are the only layer allowed to implement business rules.

User interfaces request actions from Business Services.

Databases persist the results of Business Services.

This separation ensures:

* Consistent behavior.
* Easier testing.
* Better scalability.
* Clear ownership of business logic.
* Reduced duplication across the platform.
