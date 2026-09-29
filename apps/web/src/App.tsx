import {
  PixelBadge,
  PixelButton,
  PixelCard,
  PixelStatCard,
} from "@pxlkit/ui-kit";

function App() {
  return (
    <main className="min-h-screen bg-black p-6">
      <div className="grid gap-4 md:grid-cols-3">
        <PixelStatCard title="CPU" value="32%" />

        <PixelStatCard title="Memory" value="68%" />

        <PixelCard title="API Status">
          <PixelBadge tone="green">ONLINE</PixelBadge>

          <div className="mt-4">
            <PixelButton tone="cyan">Refresh</PixelButton>
          </div>
        </PixelCard>
      </div>
    </main>
  );
}

export default App;
