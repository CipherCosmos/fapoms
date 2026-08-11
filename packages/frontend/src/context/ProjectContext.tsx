/**
 * Compatibility shim.
 *
 * The global filter used to be project-only and lived here. It now covers region, zone, state
 * and client too — see `ScopeContext`. These re-exports keep the existing `useProject()` call
 * sites working; new code should use `useScope()`, which exposes the same project fields plus
 * the rest of the scope.
 */

export { ScopeProvider as ProjectProvider, useScope as useProject } from './ScopeContext';
export type { ProjectOption } from './ScopeContext';
