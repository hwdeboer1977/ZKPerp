import { NavLink, useMatch } from 'react-router-dom';

export function Navigation() {
  // Manual active detection for routes with dynamic subroutes.
  // NavLink's built-in isActive only matches exact paths by default.
  const tradeActive = useMatch('/trade/*');
  const liquidityActive = useMatch('/liquidity/*');

  const linkClass = (active: boolean) =>
    `px-5 py-4 text-sm font-medium transition-all border-b-2 ${
      active
        ? 'text-cyan-300 border-cyan-400'
        : 'text-slate-400 border-transparent hover:text-white hover:border-slate-600'
    }`;

  return (
    <nav className="border-b border-cyan-400/10 bg-white/[0.02] backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex gap-1">
          {/* Trade — links to BTC by default, stays active on all /trade/* */}
          <NavLink to="/trade/btc" className={linkClass(!!tradeActive)}>
            <span className="mr-1.5">📈</span>Trade
          </NavLink>

          {/* Liquidity — links to BTC by default, stays active on all /liquidity/* */}
          <NavLink to="/liquidity/btc" className={linkClass(!!liquidityActive)}>
            <span className="mr-1.5">💧</span>Liquidity
          </NavLink>

          {/* Static routes — use NavLink's built-in isActive */}
          <NavLink to="/darkpool" className={({ isActive }) => linkClass(isActive)}>
            <span className="mr-1.5">🌑</span>ZK Darkpool
          </NavLink>

          <NavLink to="/status" className={({ isActive }) => linkClass(isActive)}>
            <span className="mr-1.5">📡</span>System Status
          </NavLink>
        </div>
      </div>
    </nav>
  );
}
