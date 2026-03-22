import { ReactNode } from 'react';

// Background decorative blobs + grid — extracted from the UI library
function BackgroundDecor() {
  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden z-0">
      {/* Banner image — left side (hooded figure) */}
      <div
        className="absolute left-0 top-0 h-full w-1/3"
        style={{
          backgroundImage: 'url(/zkperp-banner.png)',
          backgroundSize: '280% auto',
          backgroundPosition: 'left center',
          maskImage: 'linear-gradient(to right, rgba(0,0,0,0.18) 0%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to right, rgba(0,0,0,0.18) 0%, transparent 100%)',
        }}
      />
      {/* Banner image — right side (armored figure) */}
      <div
        className="absolute right-0 top-0 h-full w-1/3"
        style={{
          backgroundImage: 'url(/zkperp-banner.png)',
          backgroundSize: '280% auto',
          backgroundPosition: 'right center',
          maskImage: 'linear-gradient(to left, rgba(0,0,0,0.18) 0%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to left, rgba(0,0,0,0.18) 0%, transparent 100%)',
        }}
      />
      {/* Glow blobs */}
      <div className="absolute left-[8%] top-[10%] h-72 w-72 rounded-full bg-cyan-400/10 blur-3xl" />
      <div className="absolute right-[10%] top-[18%] h-80 w-80 rounded-full bg-violet-500/10 blur-3xl" />
      <div className="absolute bottom-[8%] left-[24%] h-72 w-72 rounded-full bg-cyan-500/8 blur-3xl" />
      {/* Grid overlay */}
      <div className="absolute inset-0 opacity-[0.04] [background-image:linear-gradient(to_right,white_1px,transparent_1px),linear-gradient(to_bottom,white_1px,transparent_1px)] [background-size:80px_80px]" />
      {/* Lock icons */}
      <div className="absolute left-[6%] top-[20%] text-7xl text-white/5 select-none">🔒</div>
      <div className="absolute right-[12%] top-[38%] text-6xl text-white/5 select-none">🔒</div>
      <div className="absolute bottom-[12%] left-[14%] text-8xl text-white/5 select-none">🔒</div>
    </div>
  );
}

interface Props {
  children: ReactNode;
}

export function AppLayout({ children }: Props) {
  return (
    <div className="min-h-screen bg-zkperp-dark text-[#e6f1ff] relative">
      <BackgroundDecor />
      <div className="relative z-10">
        {children}
      </div>
    </div>
  );
}
