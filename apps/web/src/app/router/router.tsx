import type { JSX } from "react";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";
import { AppLayout } from "../layouts/app-layout";
import { DashboardPage } from "../../features/dashboard/pages/dashboard-page";

const router = createBrowserRouter([
  { path: "/", element: <Navigate to="/dashboard" replace /> },
  {
    element: <AppLayout />,
    children: [{ path: "/dashboard", element: <DashboardPage /> }],
  },
  { path: "*", element: <Navigate to="/dashboard" replace /> },
]);

export function AppRouter(): JSX.Element {
  return <RouterProvider router={router} />;
}
