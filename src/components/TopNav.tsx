import { LogOut, Moon, Plus, Sun } from 'lucide-react';
import type { UserSession } from '../shared/types';

export type ActiveTab =
  | 'dashboard'
  | 'transactions'
  | 'investments'
  | 'quick-capture'
  | 'accounts';

interface TopNavProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  onOpenNewTransaction: () => void;
  pendingDraftsCount: number;
  user: UserSession;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onLogout: () => void;
}

const NAV_ITEMS: ReadonlyArray<{ id: ActiveTab; label: string }> = [
  { id: 'dashboard', label: 'Resumen' },
  { id: 'transactions', label: 'Movimientos' },
  { id: 'investments', label: 'Inversiones' },
  { id: 'quick-capture', label: 'Carga Rápida' },
  { id: 'accounts', label: 'Cuentas' },
];

export function TopNav({
  activeTab,
  onSelectTab,
  onOpenNewTransaction,
  pendingDraftsCount,
  user,
  theme,
  onToggleTheme,
  onLogout,
}: TopNavProps) {
  return (
    <header className="sticky top-0 z-30 bg-white border-b border-slate-200 shadow-2xs">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-6">
        {/* Zona 1: Wordmark */}
        <a
          href="#resumen"
          onClick={(e) => {
            e.preventDefault();
            onSelectTab('dashboard');
          }}
          className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 flex items-center gap-2"
        >
          <span className="w-2.5 h-2.5 rounded-xs bg-indigo-600 inline-block" aria-hidden="true" />
          <span>Patrimonio</span>
        </a>

        {/* Zona 2: Botones de navegación con recuadro táctil claro */}
        <nav
          aria-label="Navegación principal"
          className="hidden md:flex items-center gap-1.5 p-1 rounded-xl bg-slate-100 border border-slate-200"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap shrink-0 transition-all cursor-pointer ${
                  isActive
                    ? 'bg-indigo-600 text-white shadow-xs border border-indigo-700'
                    : 'text-slate-700 hover:bg-white hover:text-slate-900 border border-transparent'
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

        {/* Zona 3: Acción primaria + Modo Oscuro/Claro + Sesión */}
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onOpenNewTransaction}
            className="btn-primary py-2 px-3.5 text-xs sm:text-sm whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            <span>Nuevo Movimiento</span>
          </button>

          <button
            type="button"
            data-testid="theme-toggle"
            onClick={onToggleTheme}
            title={theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
            aria-label={theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
            className="btn-secondary py-2 px-3 text-xs whitespace-nowrap shrink-0"
          >
            {theme === 'dark' ? (
              <>
                <Sun className="w-4 h-4 text-amber-400" aria-hidden="true" />
                <span className="hidden sm:inline">Claro</span>
              </>
            ) : (
              <>
                <Moon className="w-4 h-4 text-indigo-600" aria-hidden="true" />
                <span className="hidden sm:inline">Oscuro</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onLogout}
            title={`Cerrar sesión (${user.email})`}
            aria-label={`Cerrar sesión de ${user.name}`}
            className="btn-secondary p-2"
          >
            <LogOut className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Navegación móvil compacta con recuadros de botón */}
      <nav
        aria-label="Navegación móvil"
        className="md:hidden flex items-center justify-around border-t border-slate-200 bg-slate-100 px-2 py-1.5 gap-1 overflow-x-auto"
      >
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap shrink-0 ${
                isActive
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'bg-white text-slate-700 border border-slate-200'
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
