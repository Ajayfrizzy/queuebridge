import type { ReactElement } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { Loading } from './Form.js';

export function RequireAuth(): ReactElement {
  const { user, loading } = useAuth();
  if (loading) return <Loading what="your session" />;
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}
