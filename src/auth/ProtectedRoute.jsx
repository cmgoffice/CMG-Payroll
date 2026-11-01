import { useAuth } from './AuthContext';
import { hasRole } from './constants';
import { Navigate, Spinner } from './router';

// Guard order matters: never decide on a half-loaded state.
export default function ProtectedRoute({ children, requireApproved = true, requireRoles }) {
  const { loading, firebaseUser, userProfile, profileError, retryProfile, logout } = useAuth();

  if (loading) return <Spinner />;
  if (!firebaseUser) return <Navigate to="/login" rememberFrom />;
  // Signed in but the profile is still being created/fetched.
  if (!userProfile && profileError) {
    return (
      <div className="auth-loading" role="alert">
        <strong>โหลดโปรไฟล์ไม่สำเร็จ ({profileError})</strong>
        <span>{profileError === 'permission-denied' ? 'Firestore Rules ปฏิเสธสิทธิ์ — ตรวจสอบว่า deploy firestore.rules แล้ว' : 'กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่'}</span>
        <div className="auth-error-actions">
          <button type="button" className="primary-button" onClick={retryProfile}>ลองใหม่</button>
          <button type="button" className="secondary-button" onClick={() => logout()}>ออกจากระบบ</button>
        </div>
      </div>
    );
  }
  if (!userProfile) return <Spinner label="กำลังโหลดโปรไฟล์..." />;
  if (userProfile.status === 'rejected') return <Navigate to="/login" />;
  if (requireApproved && userProfile.status === 'pending') return <Navigate to="/pending" />;
  if (requireRoles?.length && !hasRole(userProfile, ...requireRoles)) return <Navigate to="/" />;
  return children;
}
