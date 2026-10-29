import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    console.error('CMG Payroll render error', error);
  }

  render() {
    if (this.state.hasError) {
      return <main className="fatal-error"><h1>ไม่สามารถโหลด CMG Payroll ได้</h1><p>กรุณารีเฟรชหน้า และตรวจสอบค่า Firebase ในไฟล์ .env</p><button onClick={() => window.location.reload()}>รีเฟรชหน้า</button></main>;
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </React.StrictMode>,
);
