import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

/** Collapses the table+detail split to a single column on narrow viewports. */
const useIsNarrow = (max = 900): boolean => {
  const [narrow, setNarrow] = useState(
    typeof window !== 'undefined' ? window.innerWidth <= max : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${max}px)`);
    const handler = () => setNarrow(mq.matches);
    handler();
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [max]);
  return narrow;
};
import { FileSpreadsheet, Eye, X, Edit2, Trash2, Building2, FolderKanban, ChevronRight, Clock, ExternalLink, Compass, AlertTriangle, RefreshCw, ChevronDown, Zap } from 'lucide-react';
import { ProjectStatus, Priority, projectStatusLabel, branchStatusLabel } from '@fapoms/shared';
import { api } from '../services/api';
import { useScope, withScope } from '../context/ScopeContext';
import { userMessage } from '../services/errors';
import { connectSocket } from '../services/socket';
import { StatusBadge, Modal, SearchInput, FilterSelect, AlertBanner, PrimaryButton, UploadExcelControls, Select, useConfirm } from '../components/ui';
import { ChipMultiSelect } from '../components/ui/ChipMultiSelect';
import { useWorkforceVocabulary, asOptions } from '../hooks/useWorkforceVocabulary';
import { localDateKey } from '../utils/statusLabels';
import { useImportJob } from '../components/import/useImportJob';
import { ImportProgressPanel } from '../components/import/ImportProgressPanel';
import { useCurrentRoles, canManageProjects, canDeleteProjects } from '../hooks/useCurrentRoles';
import { fetchWholeBranchDirectory } from '../services/branch-directory';

interface ClientOption {
  id: string;
  name: string;
  clientCode: string;
}

interface ProjectItem {
  id: string;
  projectNumber: string;
  name: string;
  clientId: string;
  status: ProjectStatus;
  priority: Priority;
  startDate: string | null;
  endDate: string | null;
  budget: number | null;
  scope: string | null;
  requiredSkills: string[] | null;
  requiredCertifications: string[] | null;
  description: string | null;
  createdAt: string;
  client?: { id: string; name: string; clientCode: string };
  /** Branch coverage, computed server-side in one grouped query. */
  branchProgress?: { total: number; assigned: number; completed: number; uncovered: number; unstaffed?: number };
}

interface ProjectDetail extends ProjectItem {
  sla: Record<string, any> | null;
  risks: Record<string, any> | null;
  milestones: Record<string, any> | null;
  dependencies: Record<string, any> | null;
  organizationId: string | null;
  updatedAt: string;
  client?: { id: string; name: string; clientCode: string; email?: string; phone?: string };
}

interface FormData {
  name: string;
  clientId: string;
  priority: Priority;
  startDate: string;
  endDate: string;
  budget: number | '';
  scope: string;
  requiredSkills: string;
  requiredCertifications: string;
  description: string;
}

// Mirrors registerWorkflow('project', ...) in project.service.ts, which is the
// authority. Cancel was previously offered only from PLANNING, so a project in
// any other live state could not be abandoned from the UI at all.
const TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  [ProjectStatus.DRAFT]: [ProjectStatus.PLANNING, ProjectStatus.CANCELLED],
  [ProjectStatus.PLANNING]: [ProjectStatus.SCHEDULING, ProjectStatus.CANCELLED],
  [ProjectStatus.SCHEDULING]: [ProjectStatus.EXECUTION, ProjectStatus.ON_HOLD, ProjectStatus.CANCELLED],
  [ProjectStatus.EXECUTION]: [ProjectStatus.VALIDATION, ProjectStatus.ON_HOLD, ProjectStatus.CANCELLED],
  [ProjectStatus.VALIDATION]: [ProjectStatus.COMPLETED, ProjectStatus.CANCELLED],
  [ProjectStatus.COMPLETED]: [ProjectStatus.ARCHIVED],
  [ProjectStatus.ON_HOLD]: [ProjectStatus.SCHEDULING, ProjectStatus.EXECUTION, ProjectStatus.CANCELLED],
  [ProjectStatus.ARCHIVED]: [],
  [ProjectStatus.CANCELLED]: [],
};

/**
 * What each transition button asks the coordinator to DO, rather than what the enum is called.
 *
 * The buttons were rendered as `→ ${target}`, so moving a project on read "→ SCHEDULING" —
 * an arrow and a database value. Nothing on that button said whether it was describing where
 * the project is now or where it would end up, and a coordinator who is not sure what a button
 * does does not press it: projects sat in DRAFT because nobody would risk "→ PLANNING".
 * Verb-first wording says what happens, and matches the stage names `projectStatusLabel`
 * already prints on the lifecycle strip right above these buttons.
 */
const TRANSITION_ACTION_LABELS: Record<ProjectStatus, string> = {
  [ProjectStatus.DRAFT]: 'Back to draft',
  [ProjectStatus.PLANNING]: 'Start planning',
  [ProjectStatus.SCHEDULING]: 'Send to scheduling',
  [ProjectStatus.EXECUTION]: 'Start field work',
  [ProjectStatus.VALIDATION]: 'Send for validation',
  [ProjectStatus.COMPLETED]: 'Mark completed',
  [ProjectStatus.ARCHIVED]: 'Archive',
  [ProjectStatus.ON_HOLD]: 'Put on hold',
  [ProjectStatus.CANCELLED]: 'Cancel',
};

const CAN_TRANSITION: Record<ProjectStatus, boolean> = {
  [ProjectStatus.DRAFT]: true,
  [ProjectStatus.PLANNING]: true,
  [ProjectStatus.SCHEDULING]: true,
  [ProjectStatus.EXECUTION]: true,
  [ProjectStatus.VALIDATION]: true,
  [ProjectStatus.COMPLETED]: true,
  [ProjectStatus.ARCHIVED]: false,
  [ProjectStatus.ON_HOLD]: true,
  [ProjectStatus.CANCELLED]: false,
};

const LIFECYCLE_INDEX: Record<ProjectStatus, number> = {
  [ProjectStatus.DRAFT]: 0,
  [ProjectStatus.PLANNING]: 1,
  [ProjectStatus.SCHEDULING]: 2,
  [ProjectStatus.EXECUTION]: 3,
  [ProjectStatus.VALIDATION]: 4,
  [ProjectStatus.COMPLETED]: 5,
  [ProjectStatus.ARCHIVED]: 6,
  [ProjectStatus.ON_HOLD]: 2,
  [ProjectStatus.CANCELLED]: -1,
};

/** The happy path, in order. Rendered as the pipeline strip. */
const PIPELINE: ProjectStatus[] = [
  ProjectStatus.DRAFT, ProjectStatus.PLANNING, ProjectStatus.SCHEDULING,
  ProjectStatus.EXECUTION, ProjectStatus.VALIDATION, ProjectStatus.COMPLETED,
];

/** States that sit outside the flow; shown only when something is actually in them. */
const OFF_PIPELINE: ProjectStatus[] = [ProjectStatus.ON_HOLD, ProjectStatus.ARCHIVED, ProjectStatus.CANCELLED];

/**
 * One colour per project status. The lifecycle strip and the status badge each kept their own
 * map, so the same status could be tinted differently depending on which control drew it —
 * COMPLETED was `--success` on the strip and `--accent-secondary` on the badge. The badge needs
 * a background as well as a foreground, so it adds one; the accent colour comes from here.
 */
const STATUS_ACCENT: Record<string, string> = {
  [ProjectStatus.DRAFT]: 'var(--text-muted)',
  [ProjectStatus.PLANNING]: 'var(--accent)',
  [ProjectStatus.SCHEDULING]: 'var(--accent)',
  [ProjectStatus.EXECUTION]: 'var(--success)',
  [ProjectStatus.VALIDATION]: 'var(--warning)',
  [ProjectStatus.COMPLETED]: 'var(--success)',
  [ProjectStatus.ON_HOLD]: 'var(--warning)',
  [ProjectStatus.ARCHIVED]: 'var(--text-muted)',
  [ProjectStatus.CANCELLED]: 'var(--danger)',
};

/** Kept as an alias so the lifecycle strip reads naturally at its call sites. */
const STAGE_TONE = STATUS_ACCENT;

/** Live states where a deadline still means something. */
const LIVE_STATES: string[] = [
  ProjectStatus.DRAFT, ProjectStatus.PLANNING, ProjectStatus.SCHEDULING,
  ProjectStatus.EXECUTION, ProjectStatus.VALIDATION, ProjectStatus.ON_HOLD,
];

/** Days to the end date, and whether that is a problem yet. */
function scheduleHealth(p: { endDate: string | null; status: ProjectStatus }) {
  if (!p.endDate || !LIVE_STATES.includes(p.status)) return null;
  const days = Math.ceil((new Date(p.endDate).getTime() - Date.now()) / 86400000);
  if (days < 0) return { days, label: `${Math.abs(days)}d overdue`, tone: 'var(--danger)' };
  if (days <= 7) return { days, label: `${days}d left`, tone: 'var(--warning)' };
  if (days <= 30) return { days, label: `${days}d left`, tone: 'var(--warning)' };
  return { days, label: `${days}d left`, tone: 'var(--text-muted)' };
}

const LIFECYCLE_STEPS = ['Draft', 'Planning', 'Scheduling', 'Execution', 'Validation', 'Completed', 'Archived'];

const getInitialProjectForm = (clientId = ''): FormData => {
  const today = new Date();
  const nextMonth = new Date();
  nextMonth.setDate(today.getDate() + 30);
  const formatDate = (d: Date) => localDateKey(d);
  return {
    name: '',
    /**
     * Blank on purpose: the server allocates the next `PRJ-<year>-###`.
     *
     * This used to be pre-filled with `PRJ-<year>-<random 4 digits>` — a guess at a number that
     * is UNIQUE in the database. A collision was therefore not discovered until save, after the
     * whole form had been filled in, and the user was rejected over a field they never chose.
     * Only the server can see every number, including those held by deleted projects.
     */
    clientId,
    priority: Priority.MEDIUM,
    startDate: formatDate(today),
    endDate: formatDate(nextMonth),
    budget: '',
    scope: '',
    // Empty by default: a required skill or certification EXCLUDES from planning every assayer
    // who does not hold it, so it must be a deliberate choice, never a form pre-fill. Pre-filling
    // "Gold, Gold Valuation" here quietly attached that gate to every new project — and since the
    // roster import records no skills, it excluded the whole eligible workforce.
    requiredSkills: '',
    requiredCertifications: '',
    description: '',
  };
};

const STATUS_BADGE_BG: Record<string, string> = {
  [ProjectStatus.DRAFT]: 'var(--status-draft-bg)',
  [ProjectStatus.PLANNING]: 'rgba(216,174,71,0.1)',
  [ProjectStatus.SCHEDULING]: 'var(--status-pending-bg)',
  [ProjectStatus.EXECUTION]: 'var(--status-active-bg)',
  [ProjectStatus.VALIDATION]: 'rgba(216,174,71,0.1)',
  [ProjectStatus.COMPLETED]: 'var(--status-active-bg)',
  [ProjectStatus.ARCHIVED]: 'var(--border-hair)',
  [ProjectStatus.ON_HOLD]: 'var(--status-pending-bg)',
  [ProjectStatus.CANCELLED]: 'var(--status-cancelled-bg)',
};

const statusBadge = (status: ProjectStatus) => ({
  background: STATUS_BADGE_BG[status] ?? 'var(--status-pending-bg)',
  // Same accent the lifecycle strip uses, so one status is one colour on this page.
  color: STATUS_ACCENT[status] ?? 'var(--status-pending)',
});

export const Projects: React.FC = () => {
  const navigate = useNavigate();
  const isNarrow = useIsNarrow();
  const [searchParams] = useSearchParams();
  const projectIdParam = searchParams.get('id');
  const roles = useCurrentRoles();
  const canManage = canManageProjects(roles);
  const canDelete = canDeleteProjects(roles);
  const { confirm, confirmDialog } = useConfirm();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [totalProjects, setTotalProjects] = useState(0);
  const [loadedPage, setLoadedPage] = useState(1);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const PAGE_SIZE = 50;
  const hasMore = loadedPage * PAGE_SIZE < totalProjects;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);

  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  // Fast path — the three fields the server actually requires; everything else defaults and
  // can be filled in later on the project. Less typing for the common "just start one" case.
  const [showQuickModal, setShowQuickModal] = useState(false);
  const [quickForm, setQuickForm] = useState<{ name: string; clientId: string; priority: Priority }>({ name: '', clientId: '', priority: Priority.MEDIUM });
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [activeTab, setActiveTab] = useState<'overview' | 'branches' | 'settings'>('overview');
  const [form, setForm] = useState<FormData>(getInitialProjectForm());
  const [isSaving, setIsSaving] = useState(false);
  /** The branch import's lifetime — shared with the Branches page. See `useImportJob`. */
  const branchImport = useImportJob();

  const [projectBranches, setProjectBranches] = useState<any[]>([]);
  const [allClientBranches, setAllClientBranches] = useState<any[]>([]);
  /**
   * Set only when some of this client's branches could not be loaded, which the search box below
   * has to admit to. Null for every client the loader got through in full, which is the normal case.
   */
  const [branchShortfall, setBranchShortfall] = useState<{ shown: number; total: number } | null>(null);
  const [branchSearch, setBranchSearch] = useState('');

  /**
   * The skills and certifications that actually exist on the roster — the same vocabulary the
   * HR capability page and the branch form pick from.
   *
   * These two fields fed the matching engine as comma-separated free text, and nothing checked
   * what was typed. "Gold Valuar" is not rejected: it becomes a requirement no assayer on the
   * roster holds, so the project quietly matches nobody and the coordinator sees an empty
   * candidate list on every branch with no hint that a typo caused it. Picking from the roster's
   * own vocabulary makes that class of mistake unrepresentable.
   *
   * `null` means "still loading"; an empty array means the HR-scoped endpoint is not readable by
   * this role, in which case the fields fall back to the free-text boxes rather than vanishing
   * and leaving no way to record a requirement at all.
   *
   * The fetch, de-dupe and sort that used to sit here are `useWorkforceVocabulary` — the same
   * three lines existed on this page, on Branches, on Rules, on the client configuration panel
   * and on Zones, and each copy had drifted. Both meanings of `null` and `[]` above are the
   * hook's contract, so the two fallbacks below are unchanged.
   */
  const { skills: skillOptions, certifications: certOptions } = useWorkforceVocabulary();
  /** Matching requirements are an expert override; most projects use the client's defaults. */
  const [showAdvancedMatching, setShowAdvancedMatching] = useState(false);

  /**
   * The form stores these as the comma-separated string the create/update handlers already
   * split on, so the chips are purely a way of editing that string. Keeping the storage format
   * untouched means the submit path, the edit-prefill and the server contract are all unchanged
   * — and a value typed before this picker existed still round-trips.
   */
  const csvValues = (raw: string) => raw.split(',').map((x) => x.trim()).filter(Boolean);

  /** The picker hands back a list; the form keeps the comma-joined string it always kept. */
  const setCsvValue = (key: 'requiredSkills' | 'requiredCertifications', next: string[]) =>
    setForm((f) => ({ ...f, [key]: next.join(', ') }));

  const { scopeParams, scopeKey } = useScope();
  const scopeQuery = withScope(scopeParams);
  // The socket handlers below bind once at mount, so they must read the scope through a ref —
  // otherwise a live project event refetches with the mount-time scope and repaints the list
  // with projects from a region the operator has since filtered out.
  const scopeQueryRef = useRef(scopeQuery);
  scopeQueryRef.current = scopeQuery;
  const scopeParamsRef = useRef(scopeParams);
  scopeParamsRef.current = scopeParams;

  // Reloads whenever the header's scope changes. A project is in scope when it has at least one
  // branch there — see ProjectQueryService.findAll.
  useEffect(() => { loadProjects(); }, [scopeKey]);

  useEffect(() => {
    loadProjects();
    loadClients();
    const socket = connectSocket();
    const refresh = () => { loadProjects(); loadClients(); };
    socket?.on('ProjectPlanningStarted', refresh);
    socket?.on('ProjectSchedulingReady', refresh);
    socket?.on('ProjectExecutionStarted', refresh);
    socket?.on('ProjectValidationStarted', refresh);
    socket?.on('ProjectCompleted', refresh);
    socket?.on('ProjectCancelled', refresh);
    return () => {
      socket?.off('ProjectPlanningStarted', refresh);
      socket?.off('ProjectSchedulingReady', refresh);
      socket?.off('ProjectExecutionStarted', refresh);
      socket?.off('ProjectValidationStarted', refresh);
      socket?.off('ProjectCompleted', refresh);
      socket?.off('ProjectCancelled', refresh);
    };
  }, []);

  useEffect(() => {
    if (projectIdParam && projects.length > 0) {
      setSelectedId(projectIdParam);
    }
  }, [projectIdParam, projects]);

  useEffect(() => {
    if (selectedId) {
      loadDetail(selectedId);
    } else {
      setDetail(null);
      setProjectBranches([]);
    }
  }, [selectedId]);

  const loadProjects = async () => {
    setIsLoading(true);
    setProjectsError(null);
    try {
      const response = await api.request<{ data: ProjectItem[]; meta: { pagination: { total: number } } }>(`/projects?page=1&limit=${PAGE_SIZE}&${scopeQueryRef.current}`, { method: 'GET', withMeta: true });
      setProjects(response.data);
      setTotalProjects(response.meta?.pagination?.total ?? response.data.length);
      setLoadedPage(1);
    } catch (err: any) {
      setProjectsError(err?.message || 'Failed to load projects.');
    } finally {
      setIsLoading(false);
    }
  };

  const loadMoreProjects = async () => {
    if (isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    try {
      const next = loadedPage + 1;
      const response = await api.request<{ data: ProjectItem[]; meta: { pagination: { total: number } } }>(`/projects?page=${next}&limit=${PAGE_SIZE}&${scopeQueryRef.current}`, { method: 'GET', withMeta: true });
      const incoming = response.data || [];
      setProjects(prev => {
        const seen = new Set(prev.map(p => p.id));
        return [...prev, ...incoming.filter(p => !seen.has(p.id))];
      });
      setTotalProjects(response.meta?.pagination?.total ?? totalProjects);
      setLoadedPage(next);
    } catch (err: any) {
      setMessage({ type: 'error', text: `Failed to load more projects. ${userMessage(err)}` });
    } finally {
      setIsLoadingMore(false);
    }
  };

  const loadClients = async () => {
    try {
      const response = await api.request<ClientOption[]>('/clients', { method: 'GET' });
      setClients(response);
    } catch (err) {
      console.error('Failed to load clients options');
    }
  };

  /**
   * Every branch this client has, not the first page of them.
   *
   * This asked for `?limit=1000` and used whatever came back. `GET /branches` clamps that to 200
   * (`branch.controller.ts`, `ParseLimitPipe({ default: 20, max: 200 })`), so on a client with
   * 3,400 branches the picker below held 200 of them and searched only those. Typing the name of
   * the 201st answered "No matching unassociated branches found." — the same words it uses for a
   * branch that is already on the project — so a branch that exists, belongs to this client and is
   * not yet associated simply could not be added, and nothing on the screen said why. Nor could
   * anything detect it: without `withMeta: true` the pagination total was thrown away by the
   * client before this function ever saw it.
   */
  const loadClientBranches = async (clientId: string) => {
    // Cleared up front so a failure here cannot leave the previous project's notice on screen.
    setBranchShortfall(null);
    try {
      const directory = await fetchWholeBranchDirectory<any>({
        query: withScope(scopeParamsRef.current, { clientId }),
      });
      setAllClientBranches(directory.branches);
      if (directory.missing > 0) {
        setBranchShortfall({ shown: directory.branches.length, total: directory.total });
      }
    } catch (err) {
      console.error('Failed to load client branches', err);
    }
  };

  const loadDetail = async (id: string) => {
    setIsLoadingDetail(true);
    try {
      const response = await api.request<ProjectDetail>(`/projects/${id}`, { method: 'GET' });
      setDetail(response);
      const branchesResponse = await api.request<any>(`/projects/${id}/branches`, { method: 'GET' });
      setProjectBranches(branchesResponse || []);
      if (response && response.clientId) {
        loadClientBranches(response.clientId);
      }
    } catch (err) {
      console.error('Failed to load project detail');
      setDetail(null);
      setProjectBranches([]);
    } finally {
      setIsLoadingDetail(false);
    }
  };

  const handleAddBranch = async (branchId: string) => {
    if (!detail) return;
    setIsSaving(true);
    setMessage(null);
    try {
      await api.request(`/projects/${detail.id}/branches`, {
        method: 'POST',
        body: JSON.stringify({ branchIds: [branchId] })
      });
      setMessage({ type: 'success', text: 'Branch associated successfully!' });
      loadDetail(detail.id);
    } catch (err: any) {
      setMessage({ type: 'error', text: `Failed to add branch. ${userMessage(err)}` });
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemoveBranch = async (projectBranchId: string) => {
    if (!detail) return;
    const ok = await confirm({
      title: 'Remove this branch from the project?',
      message: 'The branch stops being part of this project, along with any planning done for it here.',
      confirmLabel: 'Remove branch',
      reversible: false,
      tone: 'danger',
    });
    if (!ok) return;
    setIsSaving(true);
    setMessage(null);
    try {
      await api.request(`/projects/${detail.id}/branches/${projectBranchId}`, {
        method: 'DELETE'
      });
      setMessage({ type: 'success', text: 'Branch removed successfully!' });
      loadDetail(detail.id);
    } catch (err: any) {
      setMessage({ type: 'error', text: `Failed to remove branch. ${userMessage(err)}` });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    // projectNumber is no longer checked here: blank means "allocate one".
    if (!form.name || !form.clientId) {
      setMessage({ type: 'error', text: 'Please fill in all mandatory fields.' });
      return;
    }
    setIsSaving(true);
    try {
      const response = await api.request<ProjectItem>('/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          // No number: the server assigns it. The request DTO refuses one, rather than ignoring
          // it, so a client that still sends one is told rather than left believing it stuck.
          clientId: form.clientId,
          priority: form.priority,
          startDate: form.startDate || undefined,
          endDate: form.endDate || undefined,
          budget: form.budget ? Number(form.budget) : undefined,
          scope: form.scope || undefined,
          requiredSkills: form.requiredSkills ? form.requiredSkills.split(',').map(s => s.trim()) : undefined,
          requiredCertifications: form.requiredCertifications ? form.requiredCertifications.split(',').map(s => s.trim()) : undefined,
          description: form.description || undefined,
        })
      });
      setMessage({ type: 'success', text: `Project "${response.name}" (${response.projectNumber}) successfully created!` });
      setShowCreateModal(false);
      setForm(getInitialProjectForm());
      loadProjects();
    } catch (err: any) {
      setMessage({ type: 'error', text: `Failed to create project. ${userMessage(err)}` });
    } finally {
      setIsSaving(false);
    }
  };

  const handleQuickCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    if (!quickForm.name.trim() || !quickForm.clientId) {
      setMessage({ type: 'error', text: 'A project needs a name and a client.' });
      return;
    }
    setIsSaving(true);
    try {
      // Only the essentials. The server allocates the PRJ-<year>-### number and the rest of the
      // record takes its defaults — dates, scope, skills and so on are added later if needed.
      const response = await api.request<ProjectItem>('/projects', {
        method: 'POST',
        body: JSON.stringify({ name: quickForm.name.trim(), clientId: quickForm.clientId, priority: quickForm.priority }),
      });
      setMessage({ type: 'success', text: `Project "${response.name}" (${response.projectNumber}) created. Add branches and details whenever you're ready.` });
      setShowQuickModal(false);
      setQuickForm({ name: '', clientId: clients[0]?.id || '', priority: Priority.MEDIUM });
      loadProjects();
    } catch (err: any) {
      setMessage({ type: 'error', text: `Could not create the project. ${userMessage(err)}` });
    } finally {
      setIsSaving(false);
    }
  };

  const openEdit = () => {
    if (!detail) return;
    setForm({
      name: detail.name,
      clientId: detail.clientId,
      priority: detail.priority,
      startDate: detail.startDate ? detail.startDate.substring(0, 10) : '',
      endDate: detail.endDate ? detail.endDate.substring(0, 10) : '',
      budget: detail.budget ?? '',
      scope: detail.scope || '',
      requiredSkills: detail.requiredSkills?.join(', ') || '',
      requiredCertifications: detail.requiredCertifications?.join(', ') || '',
      description: detail.description || '',
    });
    setShowEditModal(true);
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    setMessage(null);
    setIsSaving(true);
    try {
      const response = await api.request<ProjectItem>(`/projects/${detail.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: form.name,
          // Not sent: the number is assigned once and never changes. It identifies the project in
          // everything already handed out, so renaming it here would rename it nowhere else.
          clientId: form.clientId,
          priority: form.priority,
          startDate: form.startDate || undefined,
          endDate: form.endDate || undefined,
          budget: form.budget ? Number(form.budget) : undefined,
          scope: form.scope || undefined,
          requiredSkills: form.requiredSkills ? form.requiredSkills.split(',').map(s => s.trim()) : undefined,
          requiredCertifications: form.requiredCertifications ? form.requiredCertifications.split(',').map(s => s.trim()) : undefined,
          description: form.description || undefined,
        })
      });
      setMessage({ type: 'success', text: `Project "${response.name}" successfully updated!` });
      setShowEditModal(false);
      loadProjects();
      if (selectedId) loadDetail(selectedId);
    } catch (err: any) {
      setMessage({ type: 'error', text: `Failed to update project. ${userMessage(err)}` });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!detail) return;
    setMessage(null);
    try {
      await api.request(`/projects/${detail.id}`, { method: 'DELETE' });
      setMessage({ type: 'success', text: `Project "${detail.name}" deleted.` });
      setShowDeleteConfirm(false);
      setSelectedId(null);
      loadProjects();
    } catch (err: any) {
      setMessage({ type: 'error', text: `Failed to delete project. ${userMessage(err)}` });
    }
  };

  const handleTransition = async (targetStatus: ProjectStatus) => {
    if (!detail) return;
    const terminal = [ProjectStatus.CANCELLED, ProjectStatus.COMPLETED, ProjectStatus.ARCHIVED].includes(targetStatus);
    // "Terminal state" is schema vocabulary — it is how the state machine describes the
    // node, not what happens to the person's project. What they need told is that the
    // project stops here and no further work can be booked against it. The status itself
    // goes through `projectStatusLabel` for the same reason: CANCELLED is a stored value,
    // "Cancelled" is a word.
    if (terminal) {
      const ok = await confirm({
        title: `Move project to ${projectStatusLabel(targetStatus)}?`,
        message: 'The project stops here. No further work can be planned or booked against it, and it cannot be moved back to an earlier stage.',
        confirmLabel: `Move to ${projectStatusLabel(targetStatus)}`,
        reversible: false,
        tone: 'danger',
      });
      if (!ok) return;
    }
    setMessage(null);
    try {
      // Sends the intent only. This used to PUT the entire project just to change
      // one field, so any value that had moved on underneath — a rename, a new
      // budget — was silently overwritten with whatever this tab last loaded.
      await api.request(`/projects/${detail.id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus }),
      });
      setMessage({ type: 'success', text: `Project moved to ${projectStatusLabel(targetStatus)}` });
      loadProjects();
      if (selectedId) loadDetail(selectedId);
    } catch (err: any) {
      setMessage({ type: 'error', text: `Transition failed. ${userMessage(err)}` });
    }
  };

  /**
   * Import branches into this project.
   *
   * This used to await the upload, read `meta`, print a sentence and stop. For a file large enough
   * to be queued there is no `meta` — the server answers 202 with a job id — so the branch of the
   * code that ran was the fallback: *"Branches uploaded."*, said the instant the work began, with
   * no way to see it finish and no report of the rows it could not use. The shared hook follows
   * the job the server named; the Branches page uses the same one, so the two screens can no
   * longer disagree about what an import did.
   */
  const handleUploadBranches = async (file: File) => {
    if (!detail) return;
    setMessage(null);
    await branchImport.start(`/projects/${detail.id}/branches/upload`, file);
  };

  /**
   * Reload the project once an import finishes.
   *
   * A queued import completes long after the upload request returned, so refreshing at the end of
   * the handler — as this page used to — redrew the branch list exactly as it had been before the
   * file was applied.
   */
  useEffect(() => {
    if (branchImport.state.phase === 'done' && detail?.id) loadDetail(detail.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchImport.state.phase, detail?.id]);

  const handleDownloadTemplate = async () => {
    if (!detail) return;
    try {
      const blob = await api.request(`/projects/${detail.id}/branches/template`, { method: 'GET', raw: true }) as Blob;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'branch_upload_template.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setMessage({ type: 'error', text: `Failed to download template. ${userMessage(err)}` });
    }
  };

  const filteredProjects = projects.filter(p => {
    const matchesSearch = p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          p.projectNumber.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'ALL' || p.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const getClientName = (clientId: string) => {
    const match = clients.find(c => c.id === clientId);
    return match ? match.name : '—';
  };


  const renderForm = (onSubmit: (e: React.FormEvent) => void, onClose: () => void, title: string) => (
    <Modal open asForm onSubmit={onSubmit} onClose={onClose} title={title} width="560px" maxHeight="90vh" closeIcon={<X size={18} />}
      footer={
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} className="btn btn-secondary" disabled={isSaving}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={isSaving}>{isSaving ? 'Saving...' : 'Save'}</button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Project Name *</label>
            <input type="text" value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. SBI Quarter 3 Audit" required style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none' }} />
          </div>

          {/*
            NO PROJECT NUMBER FIELD. The server assigns it — see `allocateProjectNumber`.

            It was an optional box saying "Left blank, one is assigned for you", which invited
            somebody to fill it in. A hand-typed number sits outside the `PRJ-<year>-###`
            sequence, so the next allocation cannot see it and the series stops being one; and
            the number is how a project is named in audit entries, document filenames, billing
            lines and every export. The confirmation after saving says which number it got.
          */}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Client *</label>
            <Select
              value={form.clientId}
              onChange={(v) => setForm(f => ({ ...f, clientId: v }))}
              options={clients.map(c => ({ value: c.id, label: `${c.name} (${c.clientCode})` }))}
              placeholder="Select client..."
              style={{ width: '100%' }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Priority *</label>
            <Select
              value={form.priority}
              onChange={(v) => setForm(f => ({ ...f, priority: v as Priority }))}
              options={Object.values(Priority).map(p => ({ value: p, label: p }))}
              style={{ width: '100%' }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Start Date</label>
              <input type="date" value={form.startDate} onChange={(e) => setForm(f => ({ ...f, startDate: e.target.value }))} style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>End Date</label>
              <input type="date" value={form.endDate} onChange={(e) => setForm(f => ({ ...f, endDate: e.target.value }))} style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none' }} />
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Budget (INR)</label>
            <input type="number" value={form.budget} onChange={(e) => setForm(f => ({ ...f, budget: e.target.value === '' ? '' : Number(e.target.value) }))} placeholder="e.g. 150000" style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Description</label>
            <textarea value={form.description} onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Project description..." style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', minHeight: '60px', resize: 'vertical' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Scope</label>
            <textarea value={form.scope} onChange={(e) => setForm(f => ({ ...f, scope: e.target.value }))} placeholder="Scope details and objectives..." style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', minHeight: '60px', resize: 'vertical' }} />
          </div>

          {/*
            * Behind a disclosure because these two fields decide who the engine will even
            * consider, and every project already arrives with sensible defaults. Sitting open in
            * the main flow they read as fields waiting to be filled in, so coordinators edited
            * them by habit and narrowed the candidate pool on projects that needed no narrowing.
            * Closed by default they are still one click away for the person who genuinely needs
            * them, and the summary line says whether anything is set without opening it.
            */}
          <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
            <button type="button" onClick={() => setShowAdvancedMatching(v => !v)} aria-expanded={showAdvancedMatching}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 600 }}>
              <ChevronDown size={14} style={{ transform: showAdvancedMatching ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }} />
              Advanced matching rules
              <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>
                {(() => {
                  const n = csvValues(form.requiredSkills).length + csvValues(form.requiredCertifications).length;
                  return n === 0 ? '— none set' : `— ${n} requirement${n === 1 ? '' : 's'} set`;
                })()}
              </span>
            </button>

            {showAdvancedMatching && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '12px' }}>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0 }}>
                  Only assayers who have everything selected here will be offered branches on this project. Leave both empty to consider the whole roster.
                </p>

                {([
                  { key: 'requiredSkills' as const, title: 'Required Skills', options: skillOptions, placeholder: 'e.g. Gold Valuer, Auditing' },
                  { key: 'requiredCertifications' as const, title: 'Required Certifications', options: certOptions, placeholder: 'e.g. Gold Valuer License' },
                ]).map(({ key, title, options, placeholder }) => {
                  const selected = csvValues(form[key]);
                  return (
                    <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{title}</label>
                      {options === null ? (
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Loading…</span>
                      ) : options.length > 0 ? (
                        /* Picked, never typed — a misspelling here matches nobody and there is
                           nothing on screen afterwards to say why the shortlist came back empty.
                           Values already stored on the project are shown alongside the roster's
                           own list so an older free-text entry stays visible and removable; the
                           shared picker does that itself (marked "(as recorded)"). */
                        <ChipMultiSelect
                          options={asOptions(options)}
                          value={selected}
                          onChange={(next) => setCsvValue(key, next)}
                          searchPlaceholder={`Search ${title.toLowerCase()}…`}
                          aria-label={title}
                        />
                      ) : (
                        /* The roster vocabulary is not readable by this role — free text rather
                           than no field, so the requirement can still be recorded. */
                        <input type="text" value={form[key]} onChange={(e) => setForm(f => ({ ...f, [key]: e.target.value }))} placeholder={placeholder}
                          style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none' }} />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
        </div>
      </div>
    </Modal>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {confirmDialog}

      {/* Page Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'var(--font-display)' }}>Projects</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>Manage all client audit cycles and monitor progress</p>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button onClick={async () => {
            try {
              const data = projects.length > 0 ? projects : await api.request<ProjectItem[]>('/projects');
              const header = ['Project Number', 'Name', 'Client', 'Status', 'Priority', 'Budget', 'Start Date', 'End Date'];
              const rows = data.map(p => [
                p.projectNumber, p.name, p.client?.name || '', p.status, p.priority,
                p.budget || '', p.startDate ? new Date(p.startDate).toLocaleDateString() : '',
                p.endDate ? new Date(p.endDate).toLocaleDateString() : ''
              ]);
              const csv = [header.join(','), ...rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
              const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a'); a.href = url; a.download = `projects_export_${new Date().toISOString().split('T')[0]}.csv`; a.click();
              URL.revokeObjectURL(url);
            } catch (e) { setMessage({ type: 'error', text: 'Export failed' }); }
          }} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', minHeight: '38px', fontSize: '13px', fontWeight: 700 }}>
            <FileSpreadsheet size={15} /> Export
          </button>
          {canManage && (
            <button
              onClick={() => { setMessage(null); setQuickForm({ name: '', clientId: clients[0]?.id || '', priority: Priority.MEDIUM }); setShowQuickModal(true); }}
              className="btn btn-secondary"
              title="Create a project with just a name and client — add the rest later"
              style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', minHeight: '38px', fontSize: '13px', fontWeight: 700 }}>
              <Zap size={15} /> Quick create
            </button>
          )}
          {canManage && (
            <PrimaryButton onClick={() => { setMessage(null); setForm(getInitialProjectForm(clients[0]?.id || '')); setShowCreateModal(true); }}>
              Create Project
            </PrimaryButton>
          )}
        </div>
      </div>

      {/* Notifications */}
      {message && (
        <AlertBanner type={message.type}>{message.text}</AlertBanner>
      )}

      {/* KPI Cards */}
      {/* The lifecycle itself, as the primary filter. The previous four tiles
          collapsed nine states into four buckets, hiding exactly the thing this
          page exists to manage — including ON_HOLD and CANCELLED entirely. */}
      <div className="glass-card" style={{ padding: '12px 14px' }}>
        <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', alignItems: 'stretch' }}>
          {PIPELINE.map((stage, i) => {
            const n = projects.filter(p => p.status === stage).length;
            const on = statusFilter === stage;
            const s = STAGE_TONE[stage];
            return (
              <React.Fragment key={stage}>
                {i > 0 && <div style={{ alignSelf: 'center', color: 'var(--text-muted)', opacity: 0.4, fontSize: '11px' }}>›</div>}
                <button
                  onClick={() => setStatusFilter(on ? 'ALL' : stage)}
                  title={`${n} project(s) in ${stage}`}
                  style={{
                    flex: '1 1 0', minWidth: '92px', padding: '9px 8px', cursor: 'pointer',
                    borderRadius: 'var(--radius-sm)', textAlign: 'left',
                    background: on ? `${s}22` : 'transparent',
                    border: `1px solid ${on ? s : 'transparent'}`,
                    opacity: n === 0 && !on ? 0.45 : 1,
                  }}>
                  <div style={{ fontSize: '19px', fontWeight: 700, color: n > 0 ? s : 'var(--text-muted)', lineHeight: 1 }}>{n}</div>
                  <div style={{ fontSize: '9.5px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', marginTop: '4px' }}>
                    {projectStatusLabel(stage)}
                  </div>
                </button>
              </React.Fragment>
            );
          })}
        </div>
        {OFF_PIPELINE.some(st => projects.some(p => p.status === st)) && (
          <div style={{ display: 'flex', gap: '8px', marginTop: '10px', paddingTop: '9px', borderTop: '1px solid var(--border-color)' }}>
            {OFF_PIPELINE.map(stage => {
              const n = projects.filter(p => p.status === stage).length;
              if (n === 0) return null;
              const on = statusFilter === stage;
              return (
                <button key={stage} onClick={() => setStatusFilter(on ? 'ALL' : stage)}
                  style={{
                    padding: '4px 10px', borderRadius: '999px', fontSize: '11px', fontWeight: 600, cursor: 'pointer',
                    background: on ? `${STAGE_TONE[stage]}22` : 'transparent',
                    border: `1px solid ${on ? STAGE_TONE[stage] : 'var(--border-color)'}`,
                    color: STAGE_TONE[stage],
                  }}>
                  {projectStatusLabel(stage)} {n}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Filter Row */}
      <div className="glass-card" style={{ padding: '14px 18px', display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center' }}>
        <SearchInput value={searchTerm} onChange={setSearchTerm} placeholder="Search by project name or code..." style={{ minWidth: '240px' }} />
        <FilterSelect value={statusFilter} onChange={setStatusFilter} options={[
          { value: 'ALL', label: 'All Statuses' },
          /* The filter offered the nine raw enum values ("ON_HOLD", "SCHEDULING"), while the
             pipeline strip immediately above it named the very same stages properly. A
             coordinator picking "ON_HOLD" here and reading "On Hold" there had no way to know
             they were the same thing. */
          ...Object.values(ProjectStatus).map(status => ({ value: status, label: projectStatusLabel(status) })),
        ]} />
        <span style={{ fontSize: '12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{filteredProjects.length} of {projects.length} results</span>
      </div>

      {/* Main Grid: Table + Detail Panel */}
      <div style={{ display: 'grid', gridTemplateColumns: selectedId && !isNarrow ? 'minmax(0, 1fr) 420px' : '1fr', gap: '24px', alignItems: 'start', transition: 'grid-template-columns 0.2s' }}>

        {/* Projects Table */}
        <div className="table-container" style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ minWidth: '780px' }}>
              <thead>
                <tr>
                  <th style={{ width: '28px' }}></th>
                  <th>Project</th>
                  <th>Client</th>
                  <th>Priority</th>
                  <th>Timeline</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'center', width: '100px' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>Loading projects...</td></tr>
                ) : projectsError ? (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: '50px 20px', color: 'var(--text-muted)' }}>
                    <AlertTriangle size={36} style={{ margin: '0 auto 10px', color: 'var(--danger)', opacity: 0.6 }} />
                    <p style={{ fontSize: '14px', color: 'var(--danger)' }}>Couldn't load projects</p>
                    <p style={{ fontSize: '12px' }}>{projectsError}</p>
                    <button onClick={loadProjects} className="btn btn-secondary" style={{ marginTop: '12px', padding: '8px 16px', fontSize: '12px' }}>
                      <RefreshCw size={14} /> Retry
                    </button>
                  </td></tr>
                ) : filteredProjects.length === 0 ? (
                  <tr><td colSpan={7} style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
                    <FolderKanban size={36} style={{ margin: '0 auto 10px', opacity: 0.3 }} />
                    <p style={{ fontSize: '14px' }}>{searchTerm || statusFilter !== 'ALL' ? 'No projects match your filters.' : 'No projects yet. Create your first one.'}</p>
                  </td></tr>
                ) : (
                  filteredProjects.map((p) => (
                    <tr key={p.id} onClick={() => { setSelectedId(selectedId === p.id ? null : p.id); navigate(`/projects?id=${p.id}`, { replace: true }); }}
                      style={{ cursor: 'pointer', background: selectedId === p.id ? 'rgba(216,174,71,0.08)' : 'transparent', borderLeft: selectedId === p.id ? '3px solid var(--accent-primary)' : '3px solid transparent', transition: 'background 0.15s' }}>
                      <td style={{ textAlign: 'center', padding: '10px 6px' }}>
                        <ChevronRight size={14} style={{ color: selectedId === p.id ? 'var(--accent-primary)' : 'var(--text-muted)', opacity: selectedId === p.id ? 1 : 0.3 }} />
                      </td>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: '14px' }}>{p.name}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace', marginTop: '1px' }}>{p.projectNumber}</div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <Building2 size={13} style={{ color: 'var(--text-muted)' }} />
                          <span style={{ fontSize: '13px' }}>{p.client?.name || getClientName(p.clientId)}</span>
                        </div>
                      </td>
                      <td>
                        <span style={{
                          color: p.priority === Priority.CRITICAL ? 'var(--priority-critical)' : p.priority === Priority.HIGH ? 'var(--priority-high)' : p.priority === Priority.MEDIUM ? 'var(--priority-medium)' : 'var(--priority-low)',
                          fontWeight: 600, fontSize: '13px'
                        }}>
                          {p.priority}
                        </span>
                      </td>
                      {/* Coverage: how far the branch book has actually got. A project
                          with no branches previously looked the same as a fully
                          scheduled one. */}
                      <td style={{ fontSize: '12px' }}>
                        {(() => {
                          const bp = p.branchProgress;
                          if (!bp || bp.total === 0) {
                            return <span style={{ color: 'var(--warning)', fontSize: '11.5px' }}>No branches</span>;
                          }
                          const pct = Math.round((bp.assigned / bp.total) * 100);
                          return (
                            <div style={{ minWidth: '92px' }} title={`${bp.assigned} covered, ${bp.completed} done, ${bp.uncovered} unable to cover, ${bp.unstaffed ?? 0} still unstaffed, of ${bp.total}`}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '3px' }}>
                                <span>{bp.assigned}/{bp.total}</span>
                                <span style={{ color: 'var(--text-muted)' }}>{pct}%</span>
                              </div>
                              <div style={{ height: '4px', borderRadius: '2px', background: 'var(--border-hair)', overflow: 'hidden' }}>
                                <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? 'var(--success)' : 'var(--accent)' }} />
                              </div>
                              {/* The question ops actually opens this page with. A project can
                                  sit at 11% covered with no visible signal that the other 89%
                                  has had no decision taken on it at all. */}
                              {(bp.unstaffed ?? 0) > 0 && (
                                <div style={{ fontSize: '10px', color: 'var(--warning)', marginTop: '2px', fontWeight: 600 }}>
                                  {bp.unstaffed} unstaffed
                                </div>
                              )}
                              {bp.uncovered > 0 && (
                                <div style={{ fontSize: '10px', color: 'var(--danger)', marginTop: '2px' }}>{bp.uncovered} uncovered</div>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      {/* Schedule: the dates, plus whether the deadline is a problem. */}
                      <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        {p.startDate ? (
                          <>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <Clock size={12} style={{ opacity: 0.5 }} />
                              {new Date(p.startDate).toLocaleDateString()} – {p.endDate ? new Date(p.endDate).toLocaleDateString() : 'Ongoing'}
                            </div>
                            {(() => {
                              const h = scheduleHealth(p);
                              return h ? <div style={{ fontSize: '11px', fontWeight: 600, color: h.tone, marginTop: '2px' }}>{h.label}</div> : null;
                            })()}
                          </>
                        ) : (
                          <span style={{ opacity: 0.5, fontStyle: 'italic' }}>Not scheduled</span>
                        )}
                      </td>
                      <td>
                        <StatusBadge className="badge" label={projectStatusLabel(p.status)} bg={statusBadge(p.status).background} color={statusBadge(p.status).color} />
                      </td>
                      <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: 'flex', gap: '6px', justifyContent: 'center' }}>
                          <button onClick={() => navigate(`/planning?projectId=${p.id}`)}
                            className="btn btn-primary"
                            style={{ padding: '5px 10px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                            <Compass size={13} /> Plan
                          </button>
                          <button onClick={() => setSelectedId(selectedId === p.id ? null : p.id)}
                            className="btn btn-secondary"
                            style={{ padding: '5px 10px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                            <Eye size={13} /> {selectedId === p.id ? 'Close' : 'Detail'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {!isLoading && !projectsError && filteredProjects.length > 0 && hasMore && (
            <div style={{ padding: '10px', textAlign: 'center', borderTop: '1px solid var(--border-hair)' }}>
              <button onClick={loadMoreProjects} disabled={isLoadingMore} className="btn btn-secondary" style={{ padding: '7px 16px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                {isLoadingMore ? <RefreshCw size={13} className="spinner" /> : <ChevronDown size={13} />}
                {isLoadingMore ? 'Loading…' : `Load more (${projects.length} of ${totalProjects})`}
              </button>
            </div>
          )}
        </div>

        {/* Detail Panel */}
        {selectedId && (
          <div className="glass-card" style={{ padding: '0', overflow: 'hidden', minHeight: '400px', display: 'flex', flexDirection: 'column' }}>
            {isLoadingDetail ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '60px 20px' }}>
                <div style={{ fontSize: '13px' }}>Loading project details...</div>
              </div>
            ) : detail ? (
              <>
                {/* Detail Header */}
                <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--border-color)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>Project Details</span>
                      <h3 style={{ fontSize: '18px', fontWeight: 700, margin: '4px 0 2px' }}>{detail.name}</h3>
                      <code style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{detail.projectNumber}</code>
                    </div>
                    <StatusBadge className="badge" label={projectStatusLabel(detail.status)} bg={statusBadge(detail.status).background} color={statusBadge(detail.status).color} />
                  </div>
                </div>
                <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-surface-2)' }}>
                  <button type="button" onClick={() => setActiveTab('overview')} style={{ flex: 1, padding: '12px 8px', border: 'none', background: 'none', borderBottom: activeTab === 'overview' ? '2px solid var(--accent-primary)' : '2px solid transparent', color: activeTab === 'overview' ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: activeTab === 'overview' ? 600 : 400, cursor: 'pointer', fontSize: '12px', transition: 'all 0.2s' }}>
                    📁 Overview
                  </button>
                  <button type="button" onClick={() => setActiveTab('branches')} style={{ flex: 1, padding: '12px 8px', border: 'none', background: 'none', borderBottom: activeTab === 'branches' ? '2px solid var(--accent-primary)' : '2px solid transparent', color: activeTab === 'branches' ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: activeTab === 'branches' ? 600 : 400, cursor: 'pointer', fontSize: '12px', transition: 'all 0.2s' }}>
                    🏢 Branches ({projectBranches.length})
                  </button>
                  <button type="button" onClick={() => setActiveTab('settings')} style={{ flex: 1, padding: '12px 8px', border: 'none', background: 'none', borderBottom: activeTab === 'settings' ? '2px solid var(--accent-primary)' : '2px solid transparent', color: activeTab === 'settings' ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: activeTab === 'settings' ? 600 : 400, cursor: 'pointer', fontSize: '12px', transition: 'all 0.2s' }}>
                    ⚙️ Settings & Workflow
                  </button>
                </div>

                {activeTab === 'overview' && (
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {/* Key Info */}
                    <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '12px' }}>
                      <div>
                        <span style={{ color: 'var(--text-muted)' }}>Client</span>
                        <div style={{ fontWeight: 600, marginTop: '1px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <Building2 size={12} style={{ color: 'var(--text-muted)' }} />
                          {detail.client?.name || getClientName(detail.clientId)}
                        </div>
                      </div>
                      <div>
                        <span style={{ color: 'var(--text-muted)' }}>Priority</span>
                        <div style={{ fontWeight: 600, marginTop: '1px', color: detail.priority === Priority.CRITICAL ? 'var(--priority-critical)' : detail.priority === Priority.HIGH ? 'var(--priority-high)' : 'var(--priority-medium)' }}>
                          {detail.priority}
                        </div>
                      </div>
                      {detail.startDate && (
                        <div>
                          <span style={{ color: 'var(--text-muted)' }}>Timeline</span>
                          <div style={{ fontWeight: 600, marginTop: '1px' }}>
                            {new Date(detail.startDate).toLocaleDateString()} – {detail.endDate ? new Date(detail.endDate).toLocaleDateString() : 'Ongoing'}
                          </div>
                        </div>
                      )}
                      {detail.budget != null && (
                        <div>
                          <span style={{ color: 'var(--text-muted)' }}>Budget</span>
                          <div style={{ fontWeight: 600, marginTop: '1px' }}>₹{Number(detail.budget).toLocaleString()}</div>
                        </div>
                      )}
                    </div>

                    {/* Scope / Description */}
                    {(detail.scope || detail.description) && (
                      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', display: 'block', marginBottom: '6px' }}>Scope & Description</span>
                        {detail.scope && <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>{detail.scope}</p>}
                        {detail.description && <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '6px 0 0', lineHeight: 1.5, fontStyle: 'italic' }}>{detail.description}</p>}
                      </div>
                    )}

                    {/* Required Qualifications */}
                    {(() => {
                      const skills = detail.requiredSkills ?? [];
                      const certs = detail.requiredCertifications ?? [];
                      if (skills.length === 0 && certs.length === 0) return null;
                      return (
                        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
                          <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', display: 'block', marginBottom: '8px' }}>Required Qualifications</span>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {skills.length > 0 && (
                              <div>
                                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Skills: </span>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '2px' }}>
                                  {skills.map((s, i) => (
                                    <span key={i} style={{ fontSize: '11px', padding: '2px 8px', background: 'rgba(216,174,71,0.08)', borderRadius: '4px', color: 'var(--accent-primary)', fontWeight: 500 }}>{s}</span>
                                  ))}
                                </div>
                              </div>
                            )}
                            {certs.length > 0 && (
                              <div>
                                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Certifications: </span>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '2px' }}>
                                  {certs.map((c, i) => (
                                    <span key={i} style={{ fontSize: '11px', padding: '2px 8px', background: 'var(--status-active-bg)', borderRadius: '4px', color: 'var(--accent-secondary)', fontWeight: 500 }}>{c}</span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {activeTab === 'branches' && (() => {
                  const unassociated = allClientBranches.filter(
                    (b: any) => !projectBranches.some((pb: any) => pb.branchId === b.id)
                  );
                  const suggestions = branchSearch.trim()
                    ? unassociated.filter((b: any) =>
                        (b.name || '').toLowerCase().includes(branchSearch.toLowerCase()) ||
                        (b.solId || '').toLowerCase().includes(branchSearch.toLowerCase()) ||
                        (b.city || '').toLowerCase().includes(branchSearch.toLowerCase())
                      )
                    : [];

                  /*
                   * Branches can only be added or uploaded while the project is still being put
                   * together; once it starts, the branch list is what assayers have been offered
                   * and what the client has been quoted, so it is frozen server-side.
                   *
                   * The controls used to be rendered only in DRAFT/PLANNING and to disappear
                   * entirely afterwards. From the coordinator's chair a missing button is
                   * indistinguishable from a broken one: support requests came in reporting that
                   * "the upload button is gone" on projects that had simply moved on. Showing the
                   * controls inert, with the reason next to them, answers the question on the
                   * screen where it is asked.
                   */
                  const branchesLocked = !(detail.status === ProjectStatus.DRAFT || detail.status === ProjectStatus.PLANNING);
                  const lockReason = 'Locked once the project starts';

                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', padding: '16px 20px', gap: '14px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}>
                          Associated Branches ({projectBranches.length})
                        </span>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          {branchesLocked && (
                            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{lockReason}</span>
                          )}
                          <div
                            aria-disabled={branchesLocked || undefined}
                            title={branchesLocked ? lockReason : undefined}
                            style={{ display: 'flex', gap: '8px', opacity: branchesLocked ? 0.45 : 1, pointerEvents: branchesLocked ? 'none' : 'auto' }}
                          >
                            <UploadExcelControls onUpload={handleUploadBranches} onDownloadTemplate={handleDownloadTemplate} accept=".xlsx,.xls" busy={branchImport.busy} busyLabel="Importing branches…" />
                          </div>
                        </div>
                      </div>

                      {/* Progress and result sit where the operator acted, not at the top of the page. */}
                      <ImportProgressPanel state={branchImport.state} onDismiss={branchImport.reset} />

                      {/* Dynamic Branch Search Adder Widget */}
                      {(
                        <div
                          aria-disabled={branchesLocked || undefined}
                          title={branchesLocked ? lockReason : undefined}
                          style={{ display: 'flex', flexDirection: 'column', gap: '8px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '10px', opacity: branchesLocked ? 0.55 : 1 }}
                        >
                          <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>
                            ADD BRANCH MANUALLY{branchesLocked ? ` — ${lockReason.toUpperCase()}` : ''}
                          </span>
                          {/*
                            Inside the box, above the search field, because it is the search field
                            it is about: this list is what the search looks through, and a search
                            over part of it answers "no matching branches" for a branch that is
                            simply not loaded — wording indistinguishable from a branch that does not
                            exist. Said plainly, and only when some are genuinely absent.
                          */}
                          {branchShortfall && (
                            <div style={{ display: 'flex', gap: '7px', alignItems: 'flex-start', fontSize: '11.5px', lineHeight: 1.5, color: 'var(--text-secondary)', background: 'var(--status-pending-bg)', border: '1px solid var(--status-pending-bg)', borderRadius: 'var(--radius-sm)', padding: '7px 9px' }}>
                              <AlertTriangle size={13} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: '2px' }} />
                              <span>
                                Only {branchShortfall.shown.toLocaleString('en-IN')} of this client's{' '}
                                {branchShortfall.total.toLocaleString('en-IN')} branches could be loaded, so the
                                search below cannot find the other {(branchShortfall.total - branchShortfall.shown).toLocaleString('en-IN')}.
                                Reload the page to try again. If the same message comes back, add the branches you
                                need with the Excel upload above instead — that does not go through this list.
                              </span>
                            </div>
                          )}
                          <input type="text" value={branchSearch} onChange={e => setBranchSearch(e.target.value)} disabled={branchesLocked}
                            placeholder={branchesLocked ? 'Branch list is fixed for this project' : 'Type branch name or code to search...'}
                            style={{ padding: '8px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '12px', cursor: branchesLocked ? 'not-allowed' : 'text' }} />
                          {!branchesLocked && branchSearch.trim() && (
                            <div style={{ maxHeight: '120px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', padding: '4px' }}>
                              {suggestions.length === 0 ? (
                                <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '6px', textAlign: 'center' }}>No matching unassociated branches found.</div>
                              ) : (
                                suggestions.slice(0, 10).map((b: any) => (
                                  <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 8px', fontSize: '11px' }}>
                                    <div>
                                      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{b.name}</span>
                                      <span style={{ color: 'var(--text-muted)', marginLeft: '6px' }}>({b.solId ?? '—'})</span>
                                    </div>
                                    {canManage && <button type="button" onClick={() => { handleAddBranch(b.id); setBranchSearch(''); }}
                                      style={{ padding: '2px 8px', fontSize: '10px', background: 'var(--accent-primary)', color: 'var(--on-accent)', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 600 }}>
                                      + Add
                                    </button>}
                                  </div>
                                ))
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {projectBranches.length === 0 ? (
                        <div style={{ border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)', padding: '30px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
                          <FileSpreadsheet size={24} style={{ margin: '0 auto 8px', opacity: 0.5 }} />
                          <p style={{ fontSize: '12px', margin: 0 }}>No branches selected for audit yet.</p>
                          <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>Search above to add manually, or upload an Excel file.</p>
                        </div>
                      ) : (
                        <div style={{ maxHeight: '280px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {projectBranches.map((pb: any) => (
                            <div key={pb.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', padding: '8px 10px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', borderLeft: '3px solid var(--accent-secondary)' }}>
                              <div>
                                <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{pb.branch?.name}</div>
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{pb.branch?.city}, {pb.branch?.state}</div>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span className="badge" style={{ fontSize: '10px', padding: '2px 8px', background: 'var(--bg-surface-2)', color: 'var(--text-muted)', borderRadius: '4px', fontWeight: 500 }}>{branchStatusLabel(pb.status)}</span>
                                {canManage && (detail.status === ProjectStatus.DRAFT || detail.status === ProjectStatus.PLANNING) && (
                                  <button type="button" aria-label="Remove branch" onClick={() => handleRemoveBranch(pb.id)}
                                    style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: '4px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <X size={14} />
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {activeTab === 'settings' && (
                  <div style={{ display: 'flex', flexDirection: 'column', padding: '16px 20px', gap: '16px' }}>
                    {/* Lifecycle Progress */}
                    {detail.status !== ProjectStatus.CANCELLED && (
                      <div>
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', display: 'block', marginBottom: '10px' }}>Lifecycle</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                          {LIFECYCLE_STEPS.map((step, i) => {
                            const currentIdx = LIFECYCLE_INDEX[detail.status];
                            const stepIdx = i;
                            const isActive = stepIdx === currentIdx;
                            const isPast = currentIdx >= 0 && stepIdx <= currentIdx;
                            return (
                              <div key={step} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                                <div style={{
                                  width: '100%', height: '4px', borderRadius: '2px',
                                  background: isActive ? 'var(--accent-primary)' : isPast ? 'var(--accent-secondary)' : 'var(--border-color)',
                                  transition: 'background 0.3s',
                                }} />
                                <span style={{
                                  fontSize: '8px', fontWeight: isActive ? 700 : 400,
                                  color: isActive ? 'var(--accent-primary)' : isPast ? 'var(--text-secondary)' : 'var(--text-muted)',
                                  whiteSpace: 'nowrap',
                                }}>
                                  {step}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Lifecycle Transitions */}
                    <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '14px' }}>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', display: 'block', marginBottom: '8px' }}>Transitions</span>
                      {!canManage ? (
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic' }}>You have read-only access to projects.</span>
                      ) : CAN_TRANSITION[detail.status] ? (
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          {TRANSITIONS[detail.status]?.map(target => (
                            <button key={target} onClick={() => handleTransition(target)}
                              style={{
                                padding: '6px 12px', fontSize: '11px', borderRadius: 'var(--radius-sm)',
                                background: target === ProjectStatus.CANCELLED ? 'var(--status-cancelled-bg)' : 'rgba(216,174,71,0.08)',
                                border: `1px solid ${target === ProjectStatus.CANCELLED ? 'var(--status-cancelled-bg)' : 'rgba(216,174,71,0.3)'}`,
                                color: target === ProjectStatus.CANCELLED ? 'var(--danger)' : 'var(--accent-primary)',
                                cursor: 'pointer', fontWeight: 600, transition: 'all 0.2s'
                              }}>
                              {TRANSITION_ACTION_LABELS[target] ?? projectStatusLabel(target)}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic' }}>No transitions available for this status.</span>
                      )}
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: '8px', borderTop: '1px solid var(--border-color)', paddingTop: '16px', marginTop: 'auto' }}>
                      <button onClick={() => navigate(`/planning?projectId=${detail.id}`)} className="btn btn-secondary" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '8px', fontSize: '12px' }}>
                        <ExternalLink size={13} /> Planning Workspace
                      </button>
                      {canManage && (
                        <button onClick={openEdit} className="btn btn-secondary" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '8px', fontSize: '12px' }}>
                          <Edit2 size={13} /> Edit
                        </button>
                      )}
                      {canDelete && (
                        <button onClick={() => { setConfirmText(''); setShowDeleteConfirm(true); }} className="btn btn-secondary" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '8px', fontSize: '12px', border: '1px solid var(--status-cancelled-bg)', color: 'var(--danger)' }}>
                          <Trash2 size={13} /> Delete
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Metadata */}
                <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border-color)', display: 'flex', gap: '16px', fontSize: '10px', color: 'var(--text-muted)', marginTop: 'auto', background: 'var(--bg-surface-2)' }}>
                  <span>Created: {new Date(detail.createdAt).toLocaleDateString()}</span>
                  <span>Updated: {new Date(detail.updatedAt).toLocaleDateString()}</span>
                </div>
              </>
            ) : (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '60px 20px' }}>
                <Building2 size={36} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
                <p style={{ fontSize: '13px' }}>Select a project to view details.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Create Modal */}
      {showCreateModal && renderForm(handleCreate, () => setShowCreateModal(false), 'Create Audit Project')}

      {showQuickModal && (
        <Modal open asForm onSubmit={handleQuickCreate} onClose={() => setShowQuickModal(false)} title="Quick create a project" width="460px" closeIcon={<X size={18} />}
          footer={
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setShowQuickModal(false)} className="btn btn-secondary" disabled={isSaving}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={isSaving}>{isSaving ? 'Creating…' : 'Create project'}</button>
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Just a name and a client to get started — a project number is assigned automatically, and you can add branches, dates, scope and required skills later.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Project name *</label>
              <input autoFocus type="text" value={quickForm.name} onChange={(e) => setQuickForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Gold Audit — Q3"
                style={{ padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Client *</label>
              <Select value={quickForm.clientId} onChange={(v) => setQuickForm(f => ({ ...f, clientId: v }))}
                options={clients.map(c => ({ value: c.id, label: `${c.name} (${c.clientCode})` }))}
                placeholder="Select client..." style={{ width: '100%' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Priority</label>
              <Select value={quickForm.priority} onChange={(v) => setQuickForm(f => ({ ...f, priority: v as Priority }))}
                options={Object.values(Priority).map(pr => ({ value: pr, label: pr }))} style={{ width: '100%' }} />
            </div>
          </div>
        </Modal>
      )}

      {/* Edit Modal */}
      {showEditModal && renderForm(handleEdit, () => setShowEditModal(false), 'Edit Project')}

      {/* Delete Confirmation */}
      <Modal open={showDeleteConfirm && !!detail} onClose={() => setShowDeleteConfirm(false)} title="Delete Project" width="400px"
        footer={
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
            <button onClick={() => setShowDeleteConfirm(false)} className="btn btn-secondary">Cancel</button>
            <button 
              onClick={handleDelete} 
              className="btn btn-primary" 
              style={{ background: 'var(--danger)', border: 'none' }}
              disabled={confirmText !== detail?.projectNumber}
            >
              Delete
            </button>
          </div>
        }
      >
        {detail && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
              Are you sure you want to delete <b>{detail.name}</b> ({detail.projectNumber})? This action cannot be undone and will soft-delete all associated branches, assignments, assessments, documents, and query threads.
            </p>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              Please type the project number <b>{detail.projectNumber}</b> to confirm:
            </p>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={detail.projectNumber}
              className="form-control"
              style={{
                width: '100%',
                padding: '8px 12px',
                border: '1px solid var(--border-hair)',
                borderRadius: '4px',
                background: 'var(--bg-card)',
                color: 'var(--text)',
              }}
            />
          </div>
        )}
      </Modal>

    </div>
  );
};
