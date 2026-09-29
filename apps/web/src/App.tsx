import type { JSX } from "react";
import { AppProviders } from "./app/providers/app-providers";
import { AppRouter } from "./app/router/router";

function App(): JSX.Element {
  return (
    <AppProviders>
      <AppRouter />
    </AppProviders>
  );
}

export default App;
