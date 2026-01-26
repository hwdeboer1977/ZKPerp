import { NavLink } from 'react-router-dom';

const navItems = [
  { to: '/', label: 'Trade', icon: '📈' },
  { to: '/liquidity', label: 'Liquidity', icon: '💧' },
  { to: '/liquidate', label: 'Liquidate', icon: '⚡' },
  { to: '/admin', label: 'Admin', icon: '⚙️' },
];

export function Navigation() {
  return (
    <nav className="bg-zkperp-card border-b border-zkperp-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex gap-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `px-6 py-4 text-sm font-medium transition-colors border-b-2 ${
                  isActive
                    ? 'text-white border-zkperp-accent'
                    : 'text-gray-400 border-transparent hover:text-white hover:border-gray-600'
                }`
              }
            >
              <span className="mr-2">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </div>
      </div>
    </nav>
  );
}
