/**
 * How long a lifecycle reason may be.
 *
 * Its own module because both ends need it and neither may import the other: the controller
 * decorates `TransitionLifecycleDto` with it, and `AssayerService.doTransitionLifecycle` enforces
 * it again at the authority boundary — where the recovery routes and any in-process caller arrive
 * without having passed a DTO at all. The controller already imports the service; importing the
 * controller back would be a cycle.
 *
 * Two thousand characters, which is several paragraphs and the ceiling this codebase already uses
 * for free text of this kind. Before there was one, `reason` was `@IsOptional() @IsString()`
 * against a 50 MB body limit: a 200,000-character reason was accepted in 92 ms and stored in FULL
 * twice — once in `audit_events.remarks`, once in `assayer_activities.remarks` — and a
 * one-megabyte one did the same. `audit_events` is append-only by database trigger, so none of it
 * could ever be reclaimed. Any holder of `assayer:edit:organization` could do it in a loop.
 */
export const LIFECYCLE_REASON_MAX_LENGTH = 2000;
