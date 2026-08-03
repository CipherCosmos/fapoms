import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';
import { queryKeys } from '../hooks/queryKeys';

export interface ProjectOption {
  id: string;
  projectNumber: string;
  name: string;
  clientId: string;
  client?: { id: string; name: string; clientCode: string };
}

interface ProjectContextValue {
  projects: ProjectOption[];
  loading: boolean;
  /** 'ALL' means no project filter is active. */
  selectedProjectId: string;
  setSelectedProjectId: (id: string) => void;
  selectedProject: ProjectOption | null;
  /** True when a specific project is selected (not 'ALL'). */
  isFiltering: boolean;
}

const ProjectContext = createContext<ProjectContextValue | undefined>(undefined);
const STORAGE_KEY = 'fapoms_selected_project';

export const ProjectProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [selectedProjectId, setSelectedProjectId] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? 'ALL',
  );

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.projects.list,
    queryFn: () =>
      api.request<{ data: ProjectOption[] }>('/projects?page=1&limit=100', {
        method: 'GET',
        withMeta: true,
      }),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const projects = useMemo(
    () => (Array.isArray(data) ? data : data?.data ?? []),
    [data],
  );

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, selectedProjectId);
  }, [selectedProjectId]);

  // If the selected project no longer exists, fall back to 'ALL'.
  useEffect(() => {
    if (selectedProjectId !== 'ALL' && projects.length > 0 && !projects.some((p) => p.id === selectedProjectId)) {
      setSelectedProjectId('ALL');
    }
  }, [projects, selectedProjectId]);

  const value = useMemo<ProjectContextValue>(() => ({
    projects,
    loading: isLoading,
    selectedProjectId,
    setSelectedProjectId,
    selectedProject: projects.find((p) => p.id === selectedProjectId) ?? null,
    isFiltering: selectedProjectId !== 'ALL',
  }), [projects, isLoading, selectedProjectId]);

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
};

export const useProject = (): ProjectContextValue => {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be used within a ProjectProvider');
  return ctx;
};
