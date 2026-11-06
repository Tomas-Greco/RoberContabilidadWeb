import { useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';

interface LoginScreenProps {
  onGoogleCredential: (credential: string) => Promise<void>;
  onDemoLogin: () => Promise<void>;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }) => void;
          renderButton: (
            parent: HTMLElement,
            options: { theme?: string; size?: string; width?: number; text?: string }
          ) => void;
        };
      };
    };
  }
}

export function LoginScreen({ onGoogleCredential, onDemoLogin }: LoginScreenProps) {
  const googleBtnRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const googleClientId =
    (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ||
    '1000204276828-dfpdv7cfnske1hctbbecivnc0icqqjbf.apps.googleusercontent.com';

  useEffect(() => {
    if (!googleClientId || !googleBtnRef.current) {
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.google && googleBtnRef.current) {
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: async (response) => {
            setError(null);
            setLoading(true);
            try {
              await onGoogleCredential(response.credential);
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Error al iniciar sesión con Google.');
            } finally {
              setLoading(false);
            }
          },
        });
        window.google.accounts.id.renderButton(googleBtnRef.current, {
          theme: 'outline',
          size: 'large',
          width: 320,
          text: 'signin_with',
        });
      }
    };
    document.head.appendChild(script);

    return () => {
      document.head.removeChild(script);
    };
  }, [googleClientId, onGoogleCredential]);

  const handleDemo = async () => {
    setError(null);
    setLoading(true);
    try {
      await onDemoLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo iniciar la sesión de prueba.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center px-4 py-12">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-8">
        <div className="flex items-center gap-2.5 text-slate-900 mb-6">
          <ShieldCheck className="w-6 h-6 text-slate-900" aria-hidden="true" />
          <span className="text-xl font-bold tracking-tight">Patrimonio</span>
        </div>

        <h1 className="text-2xl font-semibold text-slate-900 tracking-tight mb-2">
          Contabilidad personal e inversiones
        </h1>
        <p className="text-sm text-slate-600 leading-relaxed mb-6">
          Libro diario bimonetario en ARS y USD, carga rápida determinística con revisión en
          staging y exportación nativa a Excel.
        </p>

        {error && (
          <div
            role="alert"
            className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700"
          >
            {error}
          </div>
        )}

        {googleClientId ? (
          <div className="mb-4 flex justify-center" ref={googleBtnRef} />
        ) : null}

        <button
          type="button"
          onClick={handleDemo}
          disabled={loading}
          className="w-full py-2.5 px-4 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-50 transition-colors cursor-pointer"
        >
          {loading ? 'Ingresando...' : 'Ingresar con cuenta de demostración'}
        </button>

        <div className="mt-6 pt-5 border-t border-slate-100 text-xs text-slate-500 flex items-center justify-between">
          <span>Aritmética exacta en centavos</span>
          <span aria-hidden="true">·</span>
          <span>Segregación ARS / USD</span>
        </div>
      </div>
    </div>
  );
}
