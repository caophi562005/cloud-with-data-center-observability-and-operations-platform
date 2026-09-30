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

const router = createBrowserRouter([
  { path: "/", element: <Navigate to="/dashboard" replace /> },
  { path: "/login", element: <LoginPage /> },
  {
    element: <ProtectedRoute />,
    children: [
      {
        element: <AppLayout />,
        children: [{ path: "/dashboard", element: <DashboardPage /> }],
      },
    ],
  },
  { path: "*", element: <Navigate to="/dashboard" replace /> },
]);

export function AppRouter(): JSX.Element {
  return <RouterProvider router={router} />;
}
