import { Link, NavLink, Route, Routes, useNavigate } from 'react-router-dom';

import { RequireAuth, useAuth } from './auth/AuthContext';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { PortfolioPage } from './pages/PortfolioPage';
import { StockPage } from './pages/StockPage';

export function App() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">Stockfolio</Link>
        <nav>
          <NavLink to="/">Dashboard</NavLink>
          {user && <NavLink to="/portfolio">Portfolio</NavLink>}
        </nav>
        <div className="spacer" />
        {user ? (
          <div className="user">
            <span className="muted">{user.name}</span>
            <button className="link" onClick={() => { logout(); void navigate('/'); }}>Log out</button>
          </div>
        ) : (
          <Link className="btn small" to="/login">Log in</Link>
        )}
      </header>

      <main>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/stocks/:exchange/:symbol" element={<StockPage />} />
          <Route path="/portfolio" element={<RequireAuth><PortfolioPage /></RequireAuth>} />
          <Route path="*" element={<div className="empty">Page not found.</div>} />
        </Routes>
      </main>
    </>
  );
}
