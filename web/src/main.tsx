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
import { ChangeRequests } from './pages/ChangeRequests';
import { Dashboard } from './pages/Dashboard';
import { Reports } from './pages/Reports';
import { AskPage } from './pages/Ask';
import { ErpSettings } from './pages/admin/Erp';
import { VendorDetail } from './pages/VendorDetail';
import { Mailbox } from './pages/Mailbox';
import { Account } from './pages/Account';
import { Users } from './pages/admin/Users';
import { Roles } from './pages/admin/Roles';
import { Workspace } from './pages/admin/Workspace';
import { Audit } from './pages/admin/Audit';
import { VendorLogin } from './pages/VendorLogin';
import { VendorPortal, VendorSignedOut } from './pages/VendorPortal';
import { PlatformProvider, RequirePlatform } from './platform/session';
import { PlatformAcceptInvite, PlatformForgot, PlatformLogin, PlatformMfaSetup, PlatformReset } from './platform/Auth';
import { PlatformShell } from './platform/Shell';
import { PlatformOverview } from './platform/Overview';
import { PlatformTenants } from './platform/Tenants';
import { PlatformTenantDetail } from './platform/TenantDetail';
import { PlatformAdmins, PlatformAudit, PlatformSettings, PlatformBilling, PlatformSignups } from './platform/Pages';
import { Signup, SignupVerify } from './pages/signup/Signup';
import { HelpProvider } from './help/HelpPanel';
import { OrderList } from './pages/orders/OrderList';
import { OrderDetail } from './pages/orders/OrderDetail';
import { PurchasingSetup } from './pages/orders/PurchasingSetup';
import { SupplierLogin } from './pages/orders/SupplierLogin';
import { SupplierOrderDetail, SupplierOrderList } from './pages/orders/SupplierOrders';
import { SupplierShell } from './orders/SupplierShell';
import { StaffInvoiceDetail, StaffInvoices, StaffPayments, SupplierInvoiceDetail, SupplierInvoices, SupplierPayments } from './pages/orders/Invoices';
import './styles.css';
import { Billing } from './pages/admin/Billing';
import { HelpTopics } from './pages/admin/HelpTopics';
import { LangGate } from './i18n/LangGate';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
        <LangGate />
        <SessionProvider>
          <HelpProvider>
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
              <Route path="changes" element={<ChangeRequests />} />
              <Route path="dashboard" element={<Dashboard />} />
              <Route path="reports" element={<Reports />} />
              <Route path="ask" element={<AskPage />} />
              <Route path="admin/erp" element={<ErpSettings />} />
              <Route path="admin/billing" element={<Billing />} />
              <Route path="admin/help-topics" element={<HelpTopics />} />
              <Route path="account" element={<Account />} />
              <Route path="admin/users" element={<Users />} />
              <Route path="admin/roles" element={<Roles />} />
              <Route path="admin/workspace" element={<Workspace />} />
              <Route path="admin/audit" element={<Audit />} />
              <Route path="admin/config" element={<ConfigEditor />} />
              <Route path="admin/integrations" element={<Integrations />} />
              <Route path="mailbox" element={<Mailbox />} />
              <Route path="orders" element={<OrderList />} />
              <Route path="orders/:id" element={<OrderDetail />} />
              <Route path="invoices" element={<StaffInvoices />} />
              <Route path="invoices/:id" element={<StaffInvoiceDetail />} />
              <Route path="payments" element={<StaffPayments />} />
              <Route path="admin/purchasing" element={<PurchasingSetup />} />
            </Route>
            <Route path="/signup" element={<Signup />} />
            <Route path="/signup/verify/:token" element={<SignupVerify />} />
            <Route path="/platform/*" element={<PlatformProvider><Routes>
              <Route path="login" element={<PlatformLogin />} />
              <Route path="setup-2fa" element={<PlatformMfaSetup />} />
              <Route path="accept-invite/:token" element={<PlatformAcceptInvite />} />
              <Route path="forgot-password" element={<PlatformForgot />} />
              <Route path="reset-password/:token" element={<PlatformReset />} />
              <Route element={<RequirePlatform><PlatformShell /></RequirePlatform>}>
                <Route index element={<PlatformOverview />} />
                <Route path="tenants" element={<PlatformTenants />} />
                <Route path="tenants/:id" element={<PlatformTenantDetail />} />
                <Route path="signups" element={<PlatformSignups />} />
                <Route path="settings" element={<PlatformSettings />} />
                <Route path="billing" element={<PlatformBilling />} />
                <Route path="admins" element={<PlatformAdmins />} />
                <Route path="audit" element={<PlatformAudit />} />
                <Route path="*" element={<Navigate to="/platform" replace />} />
              </Route>
            </Routes></PlatformProvider>} />
            <Route path="/onboard/:token" element={<VendorLogin />} />
            <Route path="/vendor" element={<VendorPortal />} />
            <Route path="/vendor/expired" element={<VendorSignedOut />} />
            <Route path="/vendor/orders" element={<SupplierShell><SupplierOrderList /></SupplierShell>} />
            <Route path="/vendor/orders/:id" element={<SupplierShell><SupplierOrderDetail /></SupplierShell>} />
            <Route path="/vendor/invoices" element={<SupplierShell><SupplierInvoices /></SupplierShell>} />
            <Route path="/vendor/invoices/:id" element={<SupplierShell><SupplierInvoiceDetail /></SupplierShell>} />
            <Route path="/vendor/payments" element={<SupplierShell><SupplierPayments /></SupplierShell>} />
            <Route path="/s/:workspace" element={<SupplierLogin />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </HelpProvider>
        </SessionProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
