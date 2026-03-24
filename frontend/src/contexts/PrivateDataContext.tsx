import { createContext, useContext, ReactNode } from 'react';
import { useUSDCx } from '@/hooks/useUSDCx';
import { useOrderReceipts } from '@/hooks/useOrderReceipts';

export type { USDCxRecord } from '@/hooks/useUSDCx';
export type { OrderReceiptRecord } from '@/hooks/useOrderReceipts';

interface PrivateDataContextValue {
  usdcx: ReturnType<typeof useUSDCx>;
  orders: ReturnType<typeof useOrderReceipts>;
}

const PrivateDataContext = createContext<PrivateDataContextValue | null>(null);

export function PrivateDataProvider({ children }: { children: ReactNode }) {
  const usdcx  = useUSDCx();
  const orders = useOrderReceipts();

  return (
    <PrivateDataContext.Provider value={{ usdcx, orders }}>
      {children}
    </PrivateDataContext.Provider>
  );
}

export function usePrivateData() {
  const ctx = useContext(PrivateDataContext);
  if (!ctx) throw new Error('usePrivateData must be used within PrivateDataProvider');
  return ctx;
}
