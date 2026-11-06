import { useCallback, useEffect, useState } from 'react';
import { AccountsCategoriesView } from './components/AccountsCategoriesView';
import { DashboardView } from './components/DashboardView';
import { LoginScreen } from './components/LoginScreen';
import { QuickCaptureView } from './components/QuickCaptureView';
import { TopNav, type ActiveTab } from './components/TopNav';
import { TransactionModal } from './components/TransactionModal';
import { TransactionsView } from './components/TransactionsView';
import { ledgerStore, type LedgerSnapshot } from './services/ledgerStore';

export default function App() {
  const [snapshot, setSnapshot] = useState<LedgerSnapshot>({
    user: null,
    accounts: [],
    categories: [],
    transactions: [],
    drafts: [],
  });
  const [loading, setLoading] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<ActiveTab>('dashboard');
  const [showNewTxModal, setShowNewTxModal] = useState<boolean>(false);

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
        Cargando libro diario...
      </div>
    );
  }

  if (!snapshot.user) {
    return (
      <LoginScreen
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
        onLogout={async () => {
          await ledgerStore.logout();
          await refresh();
        }}
      />

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-8">
        {activeTab === 'dashboard' && (
          <DashboardView
            accounts={snapshot.accounts}
            categories={snapshot.categories}
            transactions={snapshot.transactions}
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
      </main>

      {showNewTxModal && (
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
      )}
    </div>
  );
}
