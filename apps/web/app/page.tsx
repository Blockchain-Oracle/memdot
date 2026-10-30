import { Button } from "@memdot/ui/components/button";

export default function Home() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-10">
      <p className="eyebrow">MemDot</p>
      <h1 className="text-h1">Token check</h1>
      <div className="flex gap-2">
        <Button>Store 3 files</Button>
        <Button variant="outline">Cancel</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="destructive">Revoke</Button>
      </div>
      <p className="font-mono text-mono tabular">bafkr4ia…q7xa2m · 1,284,903</p>
    </main>
  );
}
