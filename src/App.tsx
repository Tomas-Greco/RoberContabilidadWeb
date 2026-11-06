import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { DashboardView } from './components/DashboardView';
import { LoginScreen } from './components/LoginScreen';
import { TopNav, type ActiveTab } from './components/TopNav';
import { ledgerStore, type LedgerSnapshot } from './services/ledgerStore';

const AccountsCategoriesView = lazy(() =>
  import('./components/AccountsCategoriesView').then((m) => ({
    default: m.AccountsCategoriesView,
  }))
);
const InvestmentsView = lazy(() =>
  import('./components/InvestmentsView').then((m) => ({ default: m.InvestmentsView }))
);
const QuickCaptureView = lazy(() =>
  import('./components/QuickCaptureView').then((m) => ({ default: m.QuickCaptureView }))
);
const TransactionsView = lazy(() =>
  import('./components/TransactionsView').then((m) => ({ default: m.TransactionsView }))
);
const TransactionModal = lazy(() =>
  import('./components/TransactionModal').then((m) => ({ default: m.TransactionModal }))
);

const THEME_STORAGE_KEY = 'patrimonio_theme_v1';

function getInitialTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  const params = new URLSearchParams(window.location.search);
  const urlTheme = params.get('theme');
  if (urlTheme === 'dark' || urlTheme === 'light') {
    return urlTheme;
  }
  const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === 'dark' || saved === 'light') {
    return saved;
  }
  return 'light';
}

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme);
  const [snapshot, setSnapshot] = useState<LedgerSnapshot>({
    user: null,
    accounts: [],
    categories: [],
    transactions: [],
    drafts: [],
    portfolios: [],
    assets: [],
    holdings: [],
    portfolioCash: [],
    trades: [],
    portfolioIncomes: [],
    snapshotDrafts: [],
  });
  const [loading, setLoading] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>('dashboard');
  const [showNewTxModal, setShowNewTxModal] = useState<boolean>(false);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage errors
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  const refresh = useCallback(async () => {
    const data = await ledgerStore.loadAll();
    setSnapshot(data);
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        if (params.get('autostart') === '1') {
          await ledgerStore.loginDemoPreview();
        }
        const data = await ledgerStore.loadAll();
        if (mounted) {
          setSnapshot(data);
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">
        Cargando libro diario y patrimonio...
      </div>
    );
  }

  if (!snapshot.user) {
    return (
      <LoginScreen
        theme={theme}
        onToggleTheme={toggleTheme}
        onGoogleCredential={async (credential) => {
          await ledgerStore.loginWithGoogleCredential(credential);
          await refresh();
        }}
        onDemoLogin={async () => {
          await ledgerStore.loginDemoPreview();
          await refresh();
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      <TopNav
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onOpenNewTransaction={() => setShowNewTxModal(true)}
        pendingDraftsCount={snapshot.drafts.length}
        user={snapshot.user}
        theme={theme}
        onToggleTheme={toggleTheme}
        onLogout={async () => {
          await ledgerStore.logout();
          await refresh();
        }}
      />

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-8">
        <Suspense
          fallback={
            <div className="py-12 text-center text-sm text-slate-500">Cargando sección...</div>
          }
        >
          {activeTab === 'dashboard' && (
            <DashboardView
              accounts={snapshot.accounts}
              categories={snapshot.categories}
              transactions={snapshot.transactions}
              portfolios={snapshot.portfolios}
              assets={snapshot.assets}
              holdings={snapshot.holdings}
              portfolioCash={snapshot.portfolioCash}
              trades={snapshot.trades}
              portfolioIncomes={snapshot.portfolioIncomes}
              onNavigate={setActiveTab}
              onOpenNewTransaction={() => setShowNewTxModal(true)}
            />
          )}

          {activeTab === 'transactions' && (
            <TransactionsView
              accounts={snapshot.accounts}
              categories={snapshot.categories}
              transactions={snapshot.transactions}
              onVoidTransaction={async (id) => {
                await ledgerStore.voidTransaction(id);
                await refresh();
              }}
            />
          )}

          {activeTab === 'investments' && (
            <InvestmentsView
              accounts={snapshot.accounts}
              portfolios={snapshot.portfolios}
              assets={snapshot.assets}
              holdings={snapshot.holdings}
              portfolioCash={snapshot.portfolioCash}
              trades={snapshot.trades}
              portfolioIncomes={snapshot.portfolioIncomes}
              snapshotDrafts={snapshot.snapshotDrafts}
              onCreatePortfolio={async (input) => {
                const p = await ledgerStore.createPortfolio(input);
                await refresh();
                return p;
              }}
              onCreateAsset={async (input) => {
                const a = await ledgerStore.createAsset(input);
                await refresh();
                return a;
              }}
              onUpdateHoldingPrice={async (input) => {
                await ledgerStore.updateHoldingPrice(input);
                await refresh();
              }}
              onUpdatePortfolioCash={async (input) => {
                await ledgerStore.updatePortfolioCash(input);
                await refresh();
              }}
              onRecordTrade={async (input) => {
                await ledgerStore.recordTrade(input);
                await refresh();
              }}
              onCreatePortfolioIncome={async (input) => {
                await ledgerStore.createPortfolioIncome(input);
                await refresh();
              }}
              onCreateSnapshotDraft={async (input) => {
                await ledgerStore.createSnapshotDraft(input);
                await refresh();
              }}
              onConfirmSnapshotDraft={async (input) => {
                await ledgerStore.confirmSnapshotDraft(input);
                await refresh();
              }}
              onDiscardSnapshotDraft={async (draftId) => {
                await ledgerStore.discardSnapshotDraft(draftId);
                await refresh();
              }}
              onRefreshUsdQuotes={async () => {
                const res = await ledgerStore.refreshUsdQuotesFromYahoo();
                await refresh();
                return res;
              }}
            />
          )}

          {activeTab === 'quick-capture' && (
            <QuickCaptureView
              accounts={snapshot.accounts}
              categories={snapshot.categories}
              transactions={snapshot.transactions}
              drafts={snapshot.drafts}
              onCreateDraft={async (input) => {
                const draft = await ledgerStore.createDraft(input);
                await refresh();
                return draft;
              }}
              onConfirmDraft={async (draftId, txInput) => {
                const tx = await ledgerStore.createTransaction(txInput);
                await ledgerStore.resolveDraft(draftId, 'confirmed', tx.id);
                await refresh();
              }}
              onDiscardDraft={async (draftId) => {
                await ledgerStore.resolveDraft(draftId, 'discarded', null);
                await refresh();
              }}
            />
          )}

          {activeTab === 'accounts' && (
            <AccountsCategoriesView
              accounts={snapshot.accounts}
              categories={snapshot.categories}
              transactions={snapshot.transactions}
              onCreateAccount={async (input) => {
                await ledgerStore.createAccount(input);
                await refresh();
              }}
              onToggleArchiveAccount={async (id, archived) => {
                await ledgerStore.toggleArchiveAccount(id, archived);
                await refresh();
              }}
              onCreateCategory={async (input) => {
                await ledgerStore.createCategory(input);
                await refresh();
              }}
            />
          )}
        </Suspense>
      </main>

      {showNewTxModal && (
        <Suspense fallback={null}>
          <TransactionModal
            accounts={snapshot.accounts}
            categories={snapshot.categories}
            existingTransactions={snapshot.transactions}
            onClose={() => setShowNewTxModal(false)}
            onSubmit={async (input) => {
              await ledgerStore.createTransaction(input);
              await refresh();
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
