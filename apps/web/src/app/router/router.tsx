import type { JSX } from "react";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";
import { AppLayout } from "../layouts/app-layout";
import { ProtectedRoute } from "./protected-route";
import { DashboardPage } from "../../features/dashboard/pages/dashboard-page";
import { LoginPage } from "../../features/auth/pages/login-page";
import { RegisterPage } from "../../features/auth/pages/register-page";
import { VmsPage } from "../../features/vms/pages/vms-page";
import { VmDetailPage } from "../../features/vms/pages/vm-detail-page";
import { AlertsPage } from "../../features/alerts/pages/alerts-page";
import { AlertRulesPage } from "../../features/alerts/pages/alert-rules-page";

const router = createBrowserRouter([
  { path: "/", element: <Navigate to="/dashboard" replace /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/register", element: <RegisterPage /> },
  {
    element: <ProtectedRoute />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: "/dashboard", element: <DashboardPage /> },
          { path: "/alerts", element: <AlertsPage /> },
          { path: "/alert-rules", element: <AlertRulesPage /> },
          { path: "/vms", element: <VmsPage /> },
          { path: "/vms/:vmId", element: <VmDetailPage /> },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/dashboard" replace /> },
]);

export function AppRouter(): JSX.Element {
  return <RouterProvider router={router} />;
}
