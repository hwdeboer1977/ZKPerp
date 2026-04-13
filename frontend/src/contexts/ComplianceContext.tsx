// src/contexts/ComplianceContext.tsx
//
// Thin wrapper — no longer needs to coordinate fetching because useCompliance()
// uses a module-level cache (_cache, _inflight) shared across all instances.
// This file exists only so existing imports of useComplianceContext() keep working.

import { createContext, useContext, ReactNode } from 'react';
import { useCompliance } from '@/hooks/useCompliance';
import type { ComplianceRecordData } from '@/hooks/useCompliance';

interface ComplianceContextValue {
  complianceRecord: ComplianceRecordData | null;
  hasRecord: boolean;
  loading: boolean;
  ensureRecord: () => Promise<ComplianceRecordData | null>;
  refetch: () => Promise<ComplianceRecordData | null>;
}

const ComplianceContext = createContext<ComplianceContextValue | null>(null);

export function ComplianceProvider({ children }: { children: ReactNode }) {
  // No useEffect, no auto-fetch — the hook itself is fully lazy.
  // All components under this provider share the module-level cache.
  const compliance = useCompliance();

  return (
    <ComplianceContext.Provider value={compliance}>
      {children}
    </ComplianceContext.Provider>
  );
}

export function useComplianceContext() {
  const ctx = useContext(ComplianceContext);
  if (!ctx) throw new Error('useComplianceContext must be used within ComplianceProvider');
  return ctx;
}
