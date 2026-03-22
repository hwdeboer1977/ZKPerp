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
        className="absolute flex flex-col items-end gap-2"
        style={{ top: '120px', right: '180px' }}
      >
        <button
          onClick={() => navigate('/trade')}
          className="px-16 py-6 rounded-xl font-bold text-2xl text-white transition-all duration-200 hover:scale-105 active:scale-95 whitespace-nowrap animate-pulse"
          style={{
            background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)',
            boxShadow: '0 0 24px rgba(168, 85, 247, 0.7), 0 4px 16px rgba(0,0,0,0.5)',
            animationDuration: '2s',
          }}
        >
          🚀 Launch App
        </button>
      </div>
    </div>
  );
}
