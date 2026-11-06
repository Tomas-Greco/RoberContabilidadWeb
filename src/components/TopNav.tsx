import { LogOut, Plus } from 'lucide-react';
import type { UserSession } from '../shared/types';

export type ActiveTab = 'dashboard' | 'transactions' | 'quick-capture' | 'accounts';

interface TopNavProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  onOpenNewTransaction: () => void;
  pendingDraftsCount: number;
  user: UserSession;
  onLogout: () => void;
}

const NAV_ITEMS: ReadonlyArray<{ id: ActiveTab; label: string }> = [
  { id: 'dashboard', label: 'Resumen' },
  { id: 'transactions', label: 'Movimientos' },
  { id: 'quick-capture', label: 'Carga Rápida' },
  { id: 'accounts', label: 'Cuentas' },
];

export function TopNav({
  activeTab,
  onSelectTab,
  onOpenNewTransaction,
  pendingDraftsCount,
  user,
  onLogout,
}: TopNavProps) {
  return (
    <header className="sticky top-0 z-30 bg-white border-b border-slate-200">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
        {/* Zona 1: Wordmark */}
        <a
          href="#resumen"
          onClick={(e) => {
            e.preventDefault();
            onSelectTab('dashboard');
          }}
          className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          Patrimonio
        </a>

        {/* Zona 2: Enlaces de navegación */}
        <nav aria-label="Navegación principal" className="hidden md:flex items-center gap-6">
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`py-1 text-sm font-medium whitespace-nowrap shrink-0 border-b-2 transition-colors cursor-pointer ${
                  isActive
                    ? 'border-slate-900 text-slate-900'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                {item.label}
                {item.id === 'quick-capture' && pendingDraftsCount > 0
                  ? ` (${pendingDraftsCount})`
                  : ''}
              </button>
            );
          })}
        </nav>

        {/* Zona 3: Acción primaria + sesión */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onOpenNewTransaction}
            className="inline-flex items-center gap-1.5 py-2 px-3.5 rounded-lg bg-slate-900 text-white text-xs sm:text-sm font-medium hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            <span>Nuevo Movimiento</span>
          </button>

          <button
            type="button"
            onClick={onLogout}
            title={`Cerrar sesión (${user.email})`}
            aria-label={`Cerrar sesión de ${user.name}`}
            className="p-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            <LogOut className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Navegación móvil compacta */}
      <nav
        aria-label="Navegación móvil"
        className="md:hidden flex items-center justify-around border-t border-slate-100 bg-white px-2 py-1.5"
      >
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-md whitespace-nowrap shrink-0 ${
                isActive ? 'bg-slate-900 text-white' : 'text-slate-600'
              }`}
            >
              {item.label}
              {item.id === 'quick-capture' && pendingDraftsCount > 0
                ? ` (${pendingDraftsCount})`
                : ''}
            </button>
          );
        })}
      </nav>
    </header>
  );
}
