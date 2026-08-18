import * as React from 'react';
import { Alert, Button, CircularProgress, Sheet, Stack, Typography } from '@mui/joy';

import type { PrivateProVaultPublicPhase } from '../vault/ProviderPrivateProVault';


export interface PrivateProVaultStatusProps {
  phase: Exclude<PrivateProVaultPublicPhase, 'setup' | 'locked' | 'ready'>;
  error: string | null;
  onRetry(): Promise<void>;
  onLogout(): Promise<void>;
}

const copy: Record<PrivateProVaultStatusProps['phase'], { title: string; body: string }> = {
  hydrating: { title: 'Opening encrypted vault', body: 'Downloading and applying the latest encrypted state.' },
  reconnecting: { title: 'Reconnect required', body: 'Private Pro cannot open or edit a stale vault.' },
  error: { title: 'Vault unavailable', body: 'The encrypted vault could not be opened safely.' },
};

export function PrivateProVaultStatus(props: PrivateProVaultStatusProps) {
  const message = copy[props.phase];
  const retryable = props.phase === 'reconnecting' || props.phase === 'error';
  return (
    <Sheet sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
      <Stack role='status' aria-live='polite' spacing={2} alignItems='center' sx={{ width: 'min(100%, 520px)', textAlign: 'center' }}>
        {!retryable && <CircularProgress aria-label={message.title} />}
        <Typography level='h2'>{message.title}</Typography>
        <Typography textColor='text.secondary'>{message.body}</Typography>
        {props.error && <Alert color='danger'>{props.error}</Alert>}
        {retryable && <Button onClick={() => void props.onRetry()}>Reconnect</Button>}
        <Button variant='plain' color='neutral' onClick={() => void props.onLogout()}>Sign out</Button>
      </Stack>
    </Sheet>
  );
}
