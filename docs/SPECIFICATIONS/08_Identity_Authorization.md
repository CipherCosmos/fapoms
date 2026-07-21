
# Part 8 – Identity, Access Control & Authorization Specification

## Field Audit Planning & Operations Management System (FAPOMS)

Version: 1.0

---

# 1. Purpose

This document defines how users authenticate, what they are authorized to access, and how permissions are enforced throughout the platform.

The authorization model combines:

* Role-Based Access Control (RBAC)
* Attribute-Based Access Control (ABAC)

This approach provides both simplicity and flexibility while supporting future multi-organization deployments.

---

# 2. Security Principles

The platform follows these principles:

* Least privilege
* Explicit permission grants
* Deny by default
* Immutable audit trail
* Separation of duties
* Ownership-based access
* No hidden permissions

Every request must be authenticated and authorized.

---

# 3. Identity Model

Every person using the system is represented as a User.

A User has:

* Identity
* Credentials
* Status
* One or more Roles
* Assigned Permissions
* Organizational Scope

A User is independent of their business role.

Example:

An employee may simultaneously be:

* Operations Manager
* Project Administrator

without creating duplicate accounts.

---

# 4. Authentication

Supported authentication mechanisms:

* Username & Password
* Email & Password
* Corporate SSO (Future)
* OAuth (Future)
* Multi-Factor Authentication (Future)

Session management should support:

* Access Token
* Refresh Token
* Session Expiration
* Forced Logout
* Device Tracking (Future)

---

# 5. User Status

A User can be:

* Invited
* Active
* Suspended
* Locked
* Disabled
* Archived

Only Active users may access the platform.

---

# 6. System Roles

Initial roles:

### Super Administrator

Responsible for:

* Platform configuration
* Organization management
* User administration
* Global settings

Unlimited access.

---

### Administrator

Responsible for:

* Operational configuration
* User management
* Reports
* Master data

---

### Operations Manager

Responsible for:

* Project planning
* Assignment planning
* Scheduling
* Coverage management
* Assayer coordination

---

### Operations Executive

Responsible for:

* Day-to-day project execution
* Contacting assayers
* Recording negotiations
* Managing schedules

---

### Validation Manager

Responsible for:

* Validation workflow
* Reviewer assignment
* Quality monitoring

---

### Validator

Responsible for:

* OCR review
* Manual corrections
* Validation approval

---

### Document Executive

Responsible for:

* Importing client data
* PDF generation
* Document dispatch
* Document tracking

---

### Assayer

Responsible for:

* Viewing assigned work
* Updating assignment progress
* Uploading required deliverables (future mobile support)

---

### Client User

Responsible for:

* Viewing own projects
* Viewing reports
* Downloading deliverables

No operational permissions.

---

### Read-Only Auditor

Responsible for:

* Compliance review
* Audit history
* Reports

Cannot modify business data.

---

# 7. Permission Categories

Permissions are grouped by business capability.

Examples:

## Project

* View
* Create
* Edit
* Archive
* Close
* Export

---

## Branch

* View
* Import
* Edit
* Merge
* Archive

---

## Assignment

* View
* Create
* Negotiate
* Accept
* Cancel
* Close

---

## Scheduling

* View
* Create
* Modify
* Reschedule

---

## Documents

* Upload
* Generate
* Download
* Replace
* Archive

---

## Validation

* Assign
* Review
* Approve
* Reject
* Reopen

---

## Administration

* Users
* Roles
* Configuration
* Reference Data
* Audit Logs

---

# 8. Permission Structure

Each permission consists of:

* Resource
* Action
* Scope

Example:

Project : Update : Organization

Assignment : View : Own Region

Validation : Review : Assigned Cases

---

# 9. Authorization Scopes

Permissions may apply to:

* Self
* Assigned Records
* Team
* Department
* Region
* State
* Client
* Organization
* Entire Platform

This allows the same permission to operate at different levels.

---

# 10. Attribute-Based Rules (ABAC)

Additional rules are evaluated using entity attributes.

Examples:

An Operations Executive may edit:

* Assignments they created.
* Assignments in their assigned region.

A Validator may update:

* Cases assigned to them.

A Client User may access:

* Only projects belonging to their organization.

A Project marked Completed becomes read-only except for Administrators.

---

# 11. Ownership Rules

Ownership influences authorization.

Examples:

Assignment Owner:

Operations Team

Document Owner:

Document Team

Validation Owner:

Validation Team

Project Owner:

Operations Manager

Only the owning team may modify active records unless elevated permissions exist.

---

# 12. Data Visibility

Users should only see information required for their responsibilities.

Examples:

Assayer:

* Own assignments only.

Validator:

* Assigned validation queue only.

Client:

* Own projects only.

Administrator:

* Entire organization.

---

# 13. Administrative Delegation

Administrators may delegate operational responsibilities without transferring platform ownership.

Delegated responsibilities should be time-bound and auditable.

---

# 14. Audit Requirements

Every security-sensitive action must record:

* User
* Timestamp
* Resource
* Previous Value
* New Value
* IP Address
* Device Identifier (Future)
* Reason (if applicable)

Audit history cannot be modified.

---

# 15. Future Security Features

The architecture should support:

* Multi-Tenant Organizations
* Single Sign-On
* Azure AD / Google Workspace Integration
* Hardware Security Keys
* Fine-Grained Policies
* API Keys
* Service Accounts
* Machine-to-Machine Authentication

without redesigning the authorization model.

---

# 16. Authorization Flow

Every request follows this sequence:

1. Authenticate the user.
2. Validate session.
3. Load roles.
4. Load permissions.
5. Evaluate attribute-based rules.
6. Check entity state.
7. Execute business operation.
8. Record audit event.

Any failure terminates the request with an authorization error.

---

# 17. Design Principles

The authorization model is designed to:

* Protect business data.
* Minimize accidental privilege escalation.
* Support organizational growth.
* Enable flexible operational structures.
* Maintain complete auditability.
* Keep authorization rules independent of business logic.

Identity, authentication, and authorization remain separate concerns while working together to secure the platform.
