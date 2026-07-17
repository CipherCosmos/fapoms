
# Part 4 — Operational Workflow & Planning Workspace

## Field Audit Planning & Operations Management System (FAPOMS)

Version: 1.0

---

# 1. Core Philosophy

Planning is an operational activity.

Assignment is a business commitment.

These two phases must remain separate.

The system should never create permanent assignments while the Operations Team is still evaluating options.

---

# 2. Planning Workspace

The Planning Workspace is the central operational area where a Project is prepared before execution.

It exists only while planning is in progress.

Its purpose is to help the Operations Team maximize branch coverage before creating confirmed assignments.

No permanent business commitments should be created during this phase.

---

# 3. Planning Workflow

```text
Receive Project
        │
        ▼
Open Planning Workspace
        │
        ▼
Analyze Branches
        │
        ▼
Find Candidate Assayers
        │
        ▼
Call Assayers
        │
        ▼
Negotiate
        │
        ▼
Check Availability
        │
        ▼
Agree Audit Date
        │
        ▼
Create Assignment
        │
        ▼
Continue Until Project Coverage Is Complete
```

Planning continues until either:

* All branches are covered, or
* No additional Assayers are available.

---

# 4. Responsibilities of the Planning Workspace

The Planning Workspace is responsible for:

* Displaying all project branches.
* Displaying operational zones.
* Showing branch locations on the map.
* Displaying nearby Assayers.
* Showing planning progress.
* Showing coverage percentage.
* Highlighting uncovered branches.
* Recording negotiation progress.
* Creating confirmed assignments.

The Planning Workspace never performs OCR, PDF generation, validation, or reporting.

---

# 5. Branch Planning States

Every Project Branch progresses through planning states.

Suggested lifecycle:

Not Planned

↓

Candidate Search

↓

Assayer Contacted

↓

Negotiation

↓

Accepted

↓

Scheduled

↓

Ready for Execution

Alternative paths:

Rejected

↓

Search New Candidate

or

Unable to Cover

This state model allows Operations to see exactly where every branch stands during planning.

---

# 6. Candidate Discovery

For every branch, the system should identify a shortlist of suitable Assayers.

The shortlist is a recommendation, not an automatic decision.

Recommendations should consider available information, such as:

* Geographic proximity
* Estimated travel effort
* Existing workload
* Previous assignment history
* Operational suitability

Negotiated fee is **not** considered because it is unknown before the phone call.

---

# 7. Human Decision Process

The platform supports, but does not replace, the Operations Team.

Typical workflow:

1. View recommended Assayers.
2. Select one.
3. Contact the Assayer.
4. Discuss availability.
5. Negotiate the professional fee.
6. Agree on an audit date.
7. Confirm the assignment.

If the Assayer declines, Operations simply proceeds to the next recommendation.

---

# 8. Coverage Management

Coverage is continuously recalculated during planning.

Coverage is defined as:

Confirmed Assignments

÷

Total Project Branches

The workspace should display:

* Total branches.
* Planned branches.
* Scheduled branches.
* Remaining branches.
* Coverage percentage.

Coverage should update immediately whenever a branch changes state.

---

# 9. Calendar Management

The calendar is a validation tool, not the planning engine.

It ensures that:

* National holidays are avoided.
* Bank holidays are avoided.
* Existing assignments do not overlap.
* An Assayer is not double-booked.

The calendar does not decide who should perform an audit.

---

# 10. Assignment Creation

A permanent Assignment should only be created after:

* An Assayer accepts the work.
* A mutually agreed audit date is established.

Everything before this point belongs to the Planning Workspace.

This separation keeps planning flexible while preserving accurate operational history.

---

# 11. Project Completion

A Project is considered fully planned when:

* Every branch has either:

  * A confirmed assignment, or
  * An explicit "Unable to Cover" decision.

Planning may finish before audit execution begins.

Execution continues independently after planning.

---

# 12. Integration with Downstream Processes

After planning is complete:

1. The Operations Team sends the planned schedule to the Client.
2. The Client uploads customer master data only for scheduled branches.
3. Master Data is downloaded.
4. PDFs are generated.
5. One day before the audit, PDFs and branch details are shared with the assigned Assayer.
6. Field audit begins.

The Planning Workspace ends once execution starts.

---

# 13. Design Principles

The Planning Workspace should:

* Separate temporary decisions from permanent records.
* Allow recommendations without enforcing them.
* Preserve complete planning history.
* Support iterative decision-making.
* Keep Operations users in control.
* Provide real-time visibility into project progress.
* Focus on maximizing coverage rather than simply assigning branches.

The objective is to make planning faster, more informed, and more transparent without changing the company's existing operational process.
