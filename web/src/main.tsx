import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ConfigProvider } from './lib/meta';
import { ConfigEditor } from './pages/admin/config/ConfigEditor';
import { Integrations } from './pages/admin/Integrations';
import { RequireStaff, SessionProvider } from './lib/session';
import { StaffShell } from './components/StaffShell';
import { Login } from './pages/auth/Login';
import { ForgotPassword } from './pages/auth/ForgotPassword';
import { ResetPassword } from './pages/auth/ResetPassword';
import { AcceptInvite } from './pages/auth/AcceptInvite';
import { VendorList } from './pages/VendorList';
import { VendorDetail } from './pages/VendorDetail';
import { Mailbox } from './pages/Mailbox';
import { Account } from './pages/Account';
import { Users } from './pages/admin/Users';
import { Roles } from './pages/admin/Roles';
import { Workspace } from './pages/admin/Workspace';
import { Audit } from './pages/admin/Audit';
import { VendorLogin } from './pages/VendorLogin';
import { VendorPortal, VendorSignedOut } from './pages/VendorPortal';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
        <SessionProvider>
          <Routes>
            <Route path="/" element={<Navigate to="/staff/vendors" replace />} />
            <Route path="/login" element={<Login />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password/:token" element={<ResetPassword />} />
            <Route path="/accept-invite/:token" element={<AcceptInvite />} />
            <Route path="/staff" element={<RequireStaff><ConfigProvider><StaffShell /></ConfigProvider></RequireStaff>}>
              <Route index element={<Navigate to="vendors" replace />} />
              <Route path="vendors" element={<VendorList />} />
              <Route path="queue" element={<VendorList mine />} />
              <Route path="vendors/:id" element={<VendorDetail />} />
              <Route path="account" element={<Account />} />
              <Route path="admin/users" element={<Users />} />
              <Route path="admin/roles" element={<Roles />} />
              <Route path="admin/workspace" element={<Workspace />} />
              <Route path="admin/audit" element={<Audit />} />
              <Route path="admin/config" element={<ConfigEditor />} />
              <Route path="admin/integrations" element={<Integrations />} />
              <Route path="mailbox" element={<Mailbox />} />
            </Route>
            <Route path="/onboard/:token" element={<VendorLogin />} />
            <Route path="/vendor" element={<VendorPortal />} />
            <Route path="/vendor/expired" element={<VendorSignedOut />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </SessionProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
