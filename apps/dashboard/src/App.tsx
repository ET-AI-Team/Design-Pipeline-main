import { useEffect, useState } from 'react';
import { JobList } from '@/components/JobList';
import { Composer } from '@/components/Composer';
import { JobTrace } from '@/components/JobTrace';
import { socket } from '@/lib/socket';
import { cn } from '@/lib/utils';
import logo from '../assests/logo-blue.png';

function ConnectionStatus() {
  const [connected, setConnected] = useState(socket.connected);

  useEffect(() => {
    function onConnect() {
      setConnected(true);
    }
    function onDisconnect() {
      setConnected(false);
    }
    // lib/socket.ts's singleton connects at module-import time, well
    // before this effect runs (React effects fire after paint) - on a
    // fast local connection the 'connect' event can already have fired
    // and been missed by the time this listener attaches. Syncing to
    // the actual current value here (not just the mount-time useState
    // initializer) is what catches that case instead of showing a
    // permanently stale "Disconnected".
    setConnected(socket.connected);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);

  return (
    <div className="flex items-center gap-[7px] text-[12.5px] font-semibold">
      <span className={cn('size-1.5 rounded-full', connected ? 'bg-success' : 'bg-destructive')} />
      <span className={connected ? 'text-success' : 'text-destructive'}>{connected ? 'Live' : 'Disconnected'}</span>
    </div>
  );
}

export default function App() {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="border-border flex h-14 shrink-0 items-center justify-between border-b px-7">
        <div className="flex items-center gap-3">
          <img src={logo} alt="Times Internet" className="h-6 w-auto" />
          <span className="bg-border h-4 w-px" />
          <span className="text-muted-foreground text-[13px]">Campaign pipeline</span>
        </div>
        <ConnectionStatus />
      </header>
      <div className="flex min-h-0 flex-1">
        <JobList selectedJobId={selectedJobId} onSelect={setSelectedJobId} />
        <main className="min-h-0 flex-1 overflow-y-auto">
          {selectedJobId ? (
            <JobTrace jobId={selectedJobId} onNewJob={setSelectedJobId} onDeleted={() => setSelectedJobId(null)} />
          ) : (
            <Composer onSubmitted={setSelectedJobId} />
          )}
        </main>
      </div>
    </div>
  );
}
