import { Navigate } from 'react-router-dom';
import { isAdminLoggedIn } from '@/lib/azureAuth';

export default function AdminRoute({ children }) {
  if (!isAdminLoggedIn()) {
    return <Navigate to="/login" replace />;
  }
  return children;
}
