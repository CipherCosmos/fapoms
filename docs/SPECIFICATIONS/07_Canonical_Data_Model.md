
# Part 7 – Canonical Business Data Model

## Field Audit Planning & Operations Management System (FAPOMS)

Version: 1.0

---

# 1. Purpose

This document defines the canonical business data model for FAPOMS.

It specifies:

* What business data exists.
* Why the data exists.
* Who owns it.
* How it relates to other business entities.
* Which data is permanent.
* Which data is transactional.
* Which data is configurable.
* Which data is historical.

This document is independent of any database technology.

It serves as the single source of truth for:

* Database Design
* API Design
* Backend Domain Models
* Frontend State Management
* Reporting
* Analytics
* Audit Trail

---

# 2. Data Classification

All business data belongs to one of the following categories.

## 2.1 Master Data

Master Data changes infrequently and is shared across the system.

Examples:

* Client
* Branch
* Assayer
* State
* District
* Zone
* Holiday Calendar
* User
* Role
* Permission
* Configuration

Characteristics:

* Long-lived
* Globally reusable
* Version controlled
* Rarely deleted

---

## 2.2 Transaction Data

Represents day-to-day business operations.

Examples:

* Project
* Assignment
* Schedule
* Communication
* Document
* Validation
* Travel Record
* Notification

Characteristics:

* Frequently created
* Immutable history
* Linked to master data

---

## 2.3 Reference Data

Lookup values used throughout the application.

Examples:

* Assignment Status
* Project Status
* Validation Status
* Document Type
* Communication Type
* Travel Mode
* User Status
* Priority
* Currency

Reference data is configurable by administrators.

---

## 2.4 Configuration Data

Organization-specific settings.

Examples:

* Working Days
* SLA Rules
* Assignment Constraints
* Default Radius
* Distance Formula
* Notification Templates
* Import Mapping
* Client Configuration

Configurations should not require code changes.

---

# 3. Aggregate Roots

The following entities are aggregate roots.

Each owns its own lifecycle.

## Client

Owns:

* Projects

---

## Project

Owns:

* Project Branches
* Assignments
* Documents
* Progress

---

## Branch

Owns:

* Permanent Branch Information

Referenced by multiple Projects.

---

## Assayer

Owns:

* Availability
* Assignment History
* Profile

---

## User

Owns:

* Authentication
* Authorization
* Preferences

---

## Validation Case

Owns:

* OCR Result
* Review Status
* Corrections

---

# 4. Entity Relationships

## Client

1 Client

↓

Many Projects

---

## Project

1 Project

↓

Many Project Branches

↓

Many Assignments

↓

Many Documents

↓

Many Communications

---

## Branch

1 Branch

↓

Many Project Branches

The same Branch may appear in multiple Projects over time.

---

## Project Branch

One Project Branch

↓

Zero or One Assignment

↓

Zero or One Schedule

↓

Many Documents

↓

Many Validation Cases

---

## Assignment

One Assignment

↓

One Assayer

↓

One Project Branch

↓

One Schedule

---

## Assayer

One Assayer

↓

Many Assignments

↓

Many Projects

↓

Many Communication Records

---

# 5. Ownership Rules

Every business entity has exactly one owner.

| Entity         | Owner          |
| -------------- | -------------- |
| Project        | Client         |
| Project Branch | Project        |
| Assignment     | Project Branch |
| Schedule       | Assignment     |
| Validation     | Project Branch |
| Document       | Project Branch |
| Communication  | Assignment     |
| Travel Record  | Assignment     |

Ownership determines lifecycle and deletion rules.

---

# 6. Immutable Data

The following data should never change once created.

* Assignment Acceptance
* Audit Completion
* Validation Approval
* Submitted Reports
* Audit Events
* Historical Communication
* Previous Versions of Documents

Corrections create new versions rather than modifying history.

---

# 7. Mutable Data

The following may be updated.

* Assayer Contact Information
* Branch Address (master correction)
* Client Details
* User Information
* Configuration
* Holiday Calendar

Every update must be audited.

---

# 8. Versioned Data

Certain entities require version history.

Examples:

* Documents
* Import Mapping
* Client Configuration
* Report Templates
* Generated PDFs
* Validation Results

No version should be overwritten.

---

# 9. Soft Delete Policy

The following entities should never be physically deleted.

* Client
* Project
* Branch
* Assignment
* Assayer
* Validation
* Schedule
* Document

Instead, records become:

* Archived
* Inactive
* Cancelled

Historical references must remain valid.

---

# 10. Geographic Data

The geographic model should support:

State

↓

District

↓

City/Town

↓

Branch

↓

Latitude

↓

Longitude

↓

Coverage Radius

↓

Nearby Assayers

Geographic information supports planning and recommendation services.

---

# 11. Audit Metadata

Every transactional entity should contain audit metadata.

Minimum attributes:

* Created By
* Created At
* Updated By
* Updated At
* Version
* Status
* Active Flag

Business-critical entities additionally require:

* Previous State
* New State
* Change Reason

---

# 12. Identity Strategy

Every entity should use a globally unique identifier.

Business identifiers (such as Client Code, Branch Code, SOL ID, Project Number) remain separate from internal system identifiers.

Internal IDs must never encode business meaning.

---

# 13. Data Integrity Rules

The canonical model must enforce:

* No orphan records.
* Referential integrity.
* Immutable historical records.
* Consistent ownership.
* Explicit state transitions.
* No duplicate master entities.
* No circular dependencies.

---

# 14. Future Extensibility

The model should allow future support for:

* Multiple organizations (multi-tenant)
* Multiple clients
* Multiple audit types
* Multiple document templates
* Multiple OCR providers
* Multiple GIS providers
* AI-assisted recommendations
* Mobile applications
* Offline synchronization
* External integrations

without requiring redesign of the core model.

---

# 15. Canonical Design Principles

The canonical business data model follows these principles:

* Separate master data from transaction data.
* Normalize permanent business entities.
* Preserve complete historical records.
* Keep business identifiers independent of system identifiers.
* Avoid duplication through shared master entities.
* Model ownership explicitly.
* Prefer configuration over hard-coded behavior.
* Design for long-term scalability and maintainability.

This document serves as the foundation for all subsequent database, API, and implementation specifications.
