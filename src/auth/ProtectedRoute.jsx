import { useAuth } from './AuthContext';
import { hasRole } from './constants';
import { Navigate, Spinner } from './router';

// Guard order matters: never decide on a half-loaded state.
export default function ProtectedRoute({ children, requireApproved = true, requireRoles }) {
  const { loading, firebaseUser, userProfile } = useAuth();

  if (loading) return <Spinner />;
  if (!firebaseUser) return <Navigate to="/login" rememberFrom />;
  // Signed in but the profile is still being created/fetched.
  if (!userProfile) return <Spinner label="กำลังโหลดโปรไฟล์..." />;
  if (userProfile.status === 'rejected') return <Navigate to="/login" />;
  if (requireApproved && userProfile.status === 'pending') return <Navigate to="/pending" />;
  if (requireRoles?.length && !hasRole(userProfile, ...requireRoles)) return <Navigate to="/" />;
  return children;
}
