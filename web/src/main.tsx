import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { MetaProvider } from './lib/meta';
import { StaffShell } from './components/StaffShell';
import { StaffLogin } from './pages/StaffLogin';
import { VendorList } from './pages/VendorList';
import { VendorDetail } from './pages/VendorDetail';
import { Mailbox } from './pages/Mailbox';
import { VendorLogin } from './pages/VendorLogin';
import { VendorPortal, VendorSignedOut } from './pages/VendorPortal';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <MetaProvider>
        <Routes>
          <Route path="/" element={<Navigate to="/staff/vendors" replace />} />
          <Route path="/login" element={<StaffLogin />} />
          <Route path="/staff" element={<StaffShell />}>
            <Route path="vendors" element={<VendorList />} />
            <Route path="queue" element={<VendorList mine />} />
            <Route path="vendors/:id" element={<VendorDetail />} />
            <Route path="mailbox" element={<Mailbox />} />
          </Route>
          <Route path="/onboard/:token" element={<VendorLogin />} />
          <Route path="/vendor" element={<VendorPortal />} />
          <Route path="/vendor/expired" element={<VendorSignedOut />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </MetaProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
