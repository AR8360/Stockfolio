import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';

import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';

export function LoginPage() {
  const { user, login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Already signed in — go to wherever they were headed.
  const destination = (location.state as { from?: string } | null)?.from ?? '/portfolio';
  if (user) return <Navigate to={destination} replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password, name);
      void navigate(destination, { replace: true });
    } catch (e: unknown) {
      // The server reports an unknown email and a wrong password identically,
      // on purpose — so this shows whatever it said rather than guessing.
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 380, margin: '40px auto' }}>
      <h1>{mode === 'login' ? 'Log in' : 'Create an account'}</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {mode === 'login' ? 'To track your portfolio.' : 'A portfolio is created for you automatically.'}
      </p>

      {error && <div className="banner error">{error}</div>}

      <form onSubmit={(e) => { void onSubmit(e); }} className="panel" style={{ display: 'grid', gap: 14 }}>
        {mode === 'register' && (
          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
          </div>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password" type="password" value={password}
            onChange={(e) => setPassword(e.target.value)} required
            minLength={mode === 'register' ? 8 : 1}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
          {mode === 'register' && <span className="muted" style={{ fontSize: 12 }}>At least 8 characters.</span>}
        </div>
        <button className="btn" type="submit" disabled={submitting}>
          {submitting ? 'Working…' : mode === 'login' ? 'Log in' : 'Create account'}
        </button>
      </form>

      <p className="muted" style={{ textAlign: 'center', marginTop: 16 }}>
        {mode === 'login' ? 'No account yet? ' : 'Already registered? '}
        <button className="link" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}>
          {mode === 'login' ? 'Create one' : 'Log in'}
        </button>
      </p>
    </div>
  );
}
