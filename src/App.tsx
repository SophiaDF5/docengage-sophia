import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { queryClient } from "./lib/queryClient";
import { useAuth } from "./hooks/useAuth";
import { supabaseConfigError } from "./lib/supabaseClient";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AppLayout } from "./components/layout/AppLayout";
import { Login } from "./pages/auth/Login";
import { Register } from "./pages/auth/Register";
import { VerifyCode } from "./pages/auth/VerifyCode";
import { CommentGenerator } from "./pages/CommentGenerator";
import { DmAssistant } from "./pages/DmAssistant";
import { Leads } from "./pages/Leads";
import { Contacts } from "./pages/Contacts";
import { ManualLeads } from "./pages/ManualLeads";
import { KeywordSearch } from "./pages/KeywordSearch";
import { Outreach } from "./pages/Outreach";
import { Settings } from "./pages/Settings";

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={user ? <Navigate to="/" replace /> : <Login />}
      />
      <Route
        path="/register"
        element={user ? <Navigate to="/" replace /> : <Register />}
      />
      <Route
        path="/verify"
        element={user ? <Navigate to="/" replace /> : <VerifyCode />}
      />
      <Route
        element={
          <AuthGuard>
            <AppLayout />
          </AuthGuard>
        }
      >
        <Route path="/" element={<CommentGenerator />} />
        <Route path="/dm" element={<DmAssistant />} />
        <Route path="/leads" element={<Leads />} />
        <Route path="/contacts" element={<Contacts />} />
        <Route path="/manual-leads" element={<ManualLeads />} />
        <Route path="/keyword-search" element={<KeywordSearch />} />
        <Route path="/outreach" element={<Outreach />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function App() {
  if (supabaseConfigError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="max-w-md text-center space-y-3">
          <p className="text-lg font-semibold">Configuration error</p>
          <p className="text-sm text-muted-foreground">{supabaseConfigError}</p>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AppRoutes />
          <Toaster position="bottom-right" />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
