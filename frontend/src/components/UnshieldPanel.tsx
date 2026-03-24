import { useState } from 'react';
import { usePrivateData } from '@/contexts/PrivateDataContext';
import { useSlots } from '@/hooks/useSlots';

type Option = 'all' | 'usdcx' | 'positions' | 'orders';

interface Props {
  slots: ReturnType<typeof useSlots>;
}

export function UnshieldPanel({ slots }: Props) {
  const { usdcx, orders } = usePrivateData();
  const [busy, setBusy] = useState<Option | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allDecrypted = slots.decrypted && usdcx.decrypted && orders.decrypted;

  const run = async (option: Option) => {
    setBusy(option);
    setError(null);
    try {
      switch (option) {
        case 'all':
          await Promise.all([
            slots.fetchAndDecryptSlots(),
            usdcx.fetchAndDecrypt(),
            orders.fetchAndDecrypt(),
          ]);
          break;
        case 'usdcx':
          await usdcx.fetchAndDecrypt();
          break;
        case 'positions':
          await slots.fetchAndDecryptSlots();
          break;
        case 'orders':
          await orders.fetchAndDecrypt();
          break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unshield failed');
    } finally {
      setBusy(null);
    }
  };

  const isBusy = busy !== null;

  const Spinner = () => (
    <svg className="animate-spin h-4 w-4 flex-shrink-0" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );

  const Dot = ({ on }: { on: boolean }) => (
    <span className={`inline-block w-2 h-2 rounded-full ${on ? 'bg-zkperp-green' : 'bg-gray-600'}`} />
  );

  return (
    <div className="bg-zkperp-card rounded-xl border border-zkperp-border overflow-hidden">
      <div className="p-4 border-b border-zkperp-border flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Your Positions</h2>
        {allDecrypted && (
          <button
            onClick={() => run('all')}
            disabled={isBusy}
            className="flex items-center gap-1.5 text-xs font-medium
              text-zkperp-accent hover:text-white
              border border-zkperp-accent/40 hover:border-zkperp-accent
              bg-zkperp-accent/10 hover:bg-zkperp-accent/20
              px-3 py-1.5 rounded-lg disabled:opacity-40 transition-all"
          >
            {isBusy
              ? <><Spinner /><span>Refreshing...</span></>
              : <><span>↻</span><span>Refresh Private Data</span></>
            }
          </button>
        )}
      </div>

      <div className="p-4 space-y-3">
        {/* Primary button — shown until all unshielded */}
        {!allDecrypted && (
          <button
            onClick={() => run('all')}
            disabled={isBusy}
            className="w-full py-4 rounded-xl font-semibold text-base transition-all border-2
              bg-zkperp-accent/10 hover:bg-zkperp-accent/20
              border-zkperp-accent/60 hover:border-zkperp-accent
              text-zkperp-accent disabled:opacity-50 disabled:cursor-not-allowed
              whitespace-pre-line leading-snug"
          >
            {busy === 'all' ? (
              <span className="flex items-center justify-center gap-2">
                <Spinner />Unshielding... (approve in Shield)
              </span>
            ) : `🛡️ Unshield All Private Info\nPrivate USDCx, slots and LP become visible`}
          </button>
        )}

        {/* Granular buttons — always visible */}
        <div className="grid grid-cols-3 gap-2">
          {[
            { key: 'usdcx' as Option,     label: 'USDCx',     on: usdcx.decrypted   },
            { key: 'positions' as Option,  label: 'Positions', on: slots.decrypted   },
            { key: 'orders' as Option,     label: 'Orders',    on: orders.decrypted  },
          ].map(({ key, label, on }) => (
            <button
              key={key}
              onClick={() => run(key)}
              disabled={isBusy}
              className="flex flex-col items-center gap-1.5 py-3 px-2 rounded-lg border border-zkperp-border
                bg-zkperp-dark hover:border-zkperp-accent/50 hover:bg-zkperp-accent/5
                text-gray-400 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed
                transition-all text-xs font-medium"
            >
              {busy === key ? <Spinner /> : <Dot on={on} />}
              <span>{label}</span>
            </button>
          ))}
        </div>

        {error && <p className="text-xs text-zkperp-red text-center">{error}</p>}
      </div>
    </div>
  );
}
