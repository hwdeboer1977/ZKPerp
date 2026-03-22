import { useNavigate } from 'react-router-dom';

export function LandingPage() {
  const navigate = useNavigate();

  return (
    <div
      className="relative"
      style={{
        width: '100vw',
        height: '100vh',
        backgroundImage: 'url(/zkperp-banner.png)',
        backgroundSize: '100% 100%',
        backgroundRepeat: 'no-repeat',
      }}
    >
      <div
        className="absolute left-1/2 flex flex-col items-center gap-3"
        style={{ top: '14%', transform: 'translateX(-50%)' }}
      >
        <button
          onClick={() => navigate('/trade')}
          className="px-14 py-4 rounded-xl font-bold text-lg text-white transition-all duration-200 hover:scale-105 active:scale-95 whitespace-nowrap"
          style={{
            background: 'linear-gradient(135deg, #16a34a 0%, #22c55e 100%)',
            boxShadow: '0 0 40px rgba(34, 197, 94, 0.8), 0 4px 20px rgba(0,0,0,0.6)',
          }}
        >
          🚀 Launch App
        </button>
        <p className="text-sm text-gray-200 opacity-80 drop-shadow-lg whitespace-nowrap">
          Built on Aleo · Zero-Knowledge Proofs · Testnet
        </p>
      </div>
    </div>
  );
}
