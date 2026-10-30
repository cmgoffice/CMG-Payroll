import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { isFirebaseConfigured } from '../lib/firebase';
import { useAuth } from './AuthContext';
import { subscribeToAllProjects, subscribeToProjectIds } from './projectService';

const ProjectContext = createContext(null);
const ACTIVE_PROJECT_KEY = 'cmg-payroll-active-project';
const DEMO_PROJECTS = [{ id: 'demo', name: 'โหมดตัวอย่าง', code: 'DEMO' }];

const readStoredProject = () => {
  try {
    return window.localStorage.getItem(ACTIVE_PROJECT_KEY) || '';
  } catch {
    return '';
  }
};

// Projects visible to the signed-in user: MasterAdmin sees all, everyone else
// only the projects a MasterAdmin assigned (updates arrive in realtime).
export function ProjectProvider({ children }) {
  const { userProfile, isMasterAdmin } = useAuth();
  const [projects, setProjects] = useState(isFirebaseConfigured ? [] : DEMO_PROJECTS);
  const [loaded, setLoaded] = useState(!isFirebaseConfigured);
  const [storedId, setStoredId] = useState(readStoredProject);
  const assignedKey = (userProfile?.assignedProjects || []).join('|');

  useEffect(() => {
    if (!isFirebaseConfigured) return undefined;
    const handlers = {
      onData: (list) => {
        setProjects(list);
        setLoaded(true);
      },
      onError: (error) => {
        console.warn('อ่านรายการโครงการไม่สำเร็จ', error);
        setLoaded(true);
      },
    };
    return isMasterAdmin
      ? subscribeToAllProjects(handlers)
      : subscribeToProjectIds(assignedKey ? assignedKey.split('|') : [], handlers);
  }, [isMasterAdmin, assignedKey]);

  const activeProjectId = useMemo(() => {
    if (projects.some((project) => project.id === storedId)) return storedId;
    return projects[0]?.id || '';
  }, [projects, storedId]);

  const selectProject = useCallback((projectId) => {
    setStoredId(projectId);
    try {
      window.localStorage.setItem(ACTIVE_PROJECT_KEY, projectId);
    } catch {
      // ignore
    }
  }, []);

  const value = useMemo(() => ({
    projects,
    loaded,
    activeProjectId,
    activeProject: projects.find((project) => project.id === activeProjectId) || null,
    selectProject,
  }), [projects, loaded, activeProjectId, selectProject]);

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export const useProjects = () => {
  const context = useContext(ProjectContext);
  if (!context) throw new Error('useProjects ต้องใช้ภายใน ProjectProvider');
  return context;
};
