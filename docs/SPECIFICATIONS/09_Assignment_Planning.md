
# Part 9 – Assignment Planning Module Specification

## Field Audit Planning & Operations Management System (FAPOMS)

Version: 1.0

---

# 1. Purpose

The Assignment Planning Module is the operational heart of FAPOMS.

Its responsibility is to transform a list of branches received under a project into confirmed assignments for assayers while optimizing operational efficiency.

This module does **not** execute audits. It supports planning, negotiation, scheduling, and assignment creation.

---

# 2. Objectives

The module shall enable Operations teams to:

* View branches awaiting planning.
* Discover nearby assayers.
* Compare candidate assayers.
* Contact assayers.
* Record negotiation outcomes.
* Confirm assignments.
* Schedule audits.
* Track planning progress.
* Monitor project coverage.

---

# 3. Module Scope

Included:

* Branch planning
* Candidate discovery
* Assignment recommendation
* Negotiation tracking
* Schedule confirmation
* Assignment creation
* Coverage monitoring

Excluded:

* PDF generation
* OCR processing
* Validation workflow
* Report submission

---

# 4. Primary Users

* Operations Manager
* Operations Executive

Secondary users:

* Administrator (override)
* Assayer (view assigned work only)

---

# 5. Planning Workspace

The module provides a dedicated Planning Workspace.

The workspace consists of:

### Left Panel

Project hierarchy:

* Client
* Project
* Planning status
* Coverage summary

---

### Center Panel

Planning Queue

Displays Project Branches requiring action.

Supports:

* Sorting
* Filtering
* Searching
* Bulk selection

---

### Right Panel

Candidate Assayer Panel

Displays recommended assayers.

Includes:

* Distance
* Primary state
* Assignment workload
* Recent activity
* Historical performance metrics
* Contact information

---

### Bottom Panel

Planning Timeline

Displays chronological planning activities.

Examples:

* Candidate searched
* Contact initiated
* Negotiation started
* Assignment accepted
* Schedule confirmed

---

# 6. Project Selection

Users begin by selecting a Project.

The workspace immediately loads:

* Branches
* Planning progress
* Coverage statistics
* Existing assignments
* Planning alerts

---

# 7. Branch Queue

Every Project Branch appears exactly once in the planning queue.

Displayed information includes:

* Branch Name
* Branch Code
* SOL ID
* State
* District
* City
* Planning Status
* Priority
* Suggested Assayer
* Scheduled Date
* Assignment Status

---

# 8. Queue Filters

Users may filter by:

Project

State

District

Zone

Planning Status

Assignment Status

Coverage Status

Priority

Scheduled Date

Assayer

Unassigned Branches

Recently Updated

Search by Branch Name, Code or SOL ID.

---

# 9. Planning States

Each Project Branch progresses through:

Imported

↓

Candidate Search

↓

Contact Initiated

↓

Negotiation

↓

Accepted

↓

Scheduled

↓

Assignment Created

↓

Planning Complete

Alternative states:

Rejected

Unable To Cover

On Hold

Cancelled

---

# 10. Candidate Discovery

The system recommends candidate assayers using:

* Geographic proximity
* Service area
* Availability
* Existing workload
* Historical assignment activity
* Configurable business rules

Recommendations assist the planner; they never create assignments automatically.

---

# 11. Candidate Comparison

Multiple candidates may be compared simultaneously.

Comparison attributes include:

* Distance
* Region
* Availability
* Active assignments
* Historical utilization
* Last assignment date
* Preferred operating areas

The final selection is always made by the Operations user.

---

# 12. Negotiation Tracking

Each candidate interaction records:

* Contact attempt
* Contact method
* Response
* Negotiation notes
* Proposed fee (if applicable)
* Proposed schedule
* Final decision

Negotiation history is immutable.

---

# 13. Assignment Confirmation

An assignment is created only after:

* Assayer acceptance
* Schedule agreement
* Planner confirmation

The system generates a permanent Assignment record linked to the Project Branch.

---

# 14. Schedule Confirmation

Before confirmation, the system validates:

* Holiday conflicts
* Existing assignments
* Duplicate scheduling
* Planner overrides

Successful validation transitions the schedule to Confirmed.

---

# 15. Coverage Dashboard

Coverage metrics include:

* Planned branches
* Remaining branches
* Scheduled branches
* Uncovered branches
* Coverage percentage
* District-wise coverage
* State-wise coverage

Coverage updates in real time.

---

# 16. Bulk Operations

Supported bulk actions:

* Candidate search
* Status update
* Assignment export
* Planner reassignment
* Schedule proposal
* Notification dispatch

Bulk operations must preserve audit history for every affected record.

---

# 17. Exception Handling

The module supports:

* No candidate available
* Candidate rejected
* Schedule conflict
* Duplicate branch
* Branch cancellation
* Project suspension

Each exception follows predefined recovery workflows.

---

# 18. Audit Trail

Every planning activity records:

* User
* Timestamp
* Previous state
* New state
* Remarks
* Related entity

Planning history cannot be edited or deleted.

---

# 19. Notifications

Events generating notifications include:

* Candidate assigned
* Assignment accepted
* Assignment rejected
* Schedule confirmed
* Planning completed
* Coverage threshold reached

Notification channels are configurable.

---

# 20. Reports

The module provides:

* Planning progress report
* Coverage report
* Assignment summary
* Pending planning report
* Assayer utilization report
* Negotiation history report

Reports support export to PDF and spreadsheet formats.

---

# 21. Performance Requirements

The module should support:

* Projects with thousands of branches.
* Concurrent planners.
* Real-time coverage updates.
* Fast candidate search.
* Responsive filtering and sorting.

Planning operations should remain responsive under enterprise-scale workloads.

---

# 22. Integration Points

This module integrates with:

* Project Management
* Branch Management
* Assayer Management
* Scheduling
* GIS Services
* Communication Services
* Notification Services
* Reporting
* Audit Logging

---

# 23. Future Enhancements

The architecture should support:

* AI-assisted candidate ranking
* Route optimization
* Automatic schedule suggestions
* Mobile planning
* Offline planning
* Predictive workload balancing
* Cost optimization

These enhancements should extend the module without changing its core responsibilities.

---

# 24. Design Principles

The Assignment Planning Module is decision-support software.

It recommends actions but leaves operational decisions to authorized users.

All planning activities are transparent, auditable, and reversible only through explicit business workflows.

The module serves as the central orchestration point for transforming project branches into executable field assignments.
