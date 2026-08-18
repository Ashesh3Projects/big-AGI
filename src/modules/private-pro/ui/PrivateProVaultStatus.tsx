import * as React from 'react';
import { Alert, Button, CircularProgress, Sheet, Stack, Typography } from '@mui/joy';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PrivateProVaultPublicPhase } from '../vault/ProviderPrivateProVault';
import type { PrivateProVaultMigrationProgress } from '../vault/privatePro.vault.migration';


export interface PrivateProVaultStatusProps {
  phase: Exclude<PrivateProVaultPublicPhase, 'setup' | 'locked' | 'ready'>;
  error: string | null;
  onRetry(): Promise<void>;
  onLogout(): Promise<void>;
  migration?: PrivateProVaultMigrationProgress | null;
  onCreateEncryptedExport?(): Promise<void>;
  onConfirmEncryptedExport?(): Promise<void>;
}

const copy: Record<PrivateProVaultStatusProps['phase'], { title: string; body: string }> = {
  hydrating: { title: 'Opening encrypted vault', body: 'Downloading and applying the latest encrypted state.' },
  migrating: { title: 'Migrating encrypted vault', body: 'Portable data remains blocked until migration is verified.' },
  reconnecting: { title: 'Reconnect required', body: 'Private Pro cannot open or edit a stale vault.' },
  error: { title: 'Vault unavailable', body: 'The encrypted vault could not be opened safely.' },
};

export function PrivateProVaultStatus(props: PrivateProVaultStatusProps) {
  const message = copy[props.phase];
  const retryable = props.phase === 'reconnecting' || props.phase === 'error';
  const createEncryptedExport = props.onCreateEncryptedExport ? () => props.onCreateEncryptedExport!() : null;
  const confirmEncryptedExport = props.onConfirmEncryptedExport ? () => props.onConfirmEncryptedExport!() : null;
  return (
    <Sheet sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
      <Stack role='status' aria-live='polite' spacing={2} alignItems='center' sx={{ width: 'min(100%, 520px)', textAlign: 'center' }}>
        {!retryable && <CircularProgress aria-label={message.title} />}
        <Typography level='h2'>{message.title}</Typography>
        <Typography textColor='text.secondary'>{message.body}</Typography>
        {props.migration && <PrivateProVaultMigrationProgressView progress={props.migration} />}
        {props.error && <Alert color='danger'>{props.error}</Alert>}
        {(retryable || props.migration?.error) && <Button onClick={() => void props.onRetry()}>{props.migration ? 'Retry migration' : 'Reconnect'}</Button>}
        {props.migration && createEncryptedExport && <Button variant='soft' onClick={() => void createEncryptedExport()}>Create encrypted export</Button>}
        {props.migration && confirmEncryptedExport && <Button color='success' onClick={() => void confirmEncryptedExport()}>I saved this encrypted export</Button>}
        <Button variant='plain' color='neutral' onClick={() => void props.onLogout()}>Sign out</Button>
      </Stack>
    </Sheet>
  );
}

const migrationLabels: Record<PrivateProVaultMigrationProgress['phase'], string> = {
  inventory: 'Inventory plaintext sources',
  'encrypt-local': 'Encrypt local portable data',
  upload: 'Upload encrypted replacements',
  'verify-cloud': 'Verify encrypted cloud state',
  commit: 'Commit encrypted migration',
  'cleanup-local': 'Remove migrated local plaintext',
  'cleanup-cloud': 'Remove migrated cloud plaintext',
  complete: 'Encrypted migration complete',
};

function PrivateProVaultMigrationProgressView(props: { progress: PrivateProVaultMigrationProgress }) {
  return <Stack spacing={0.5} alignItems='center'>
    <Typography level='title-md'>{migrationLabels[props.progress.phase]}</Typography>
    <Typography level='body-sm' textColor='text.secondary'>{props.progress.completedItems} of {props.progress.totalItems} source items cleaned</Typography>
    {!!props.progress.deferredLocalAssets && <Typography level='body-sm' color='warning'>
      {props.progress.deferredLocalAssets} local attachment{props.progress.deferredLocalAssets === 1 ? '' : 's'} retained because active references could not be excluded.
    </Typography>}
  </Stack>;
}

export function renderPrivateProVaultMigrationProgress(progress: PrivateProVaultMigrationProgress): string {
  return renderToStaticMarkup(<PrivateProVaultStatus
    phase='migrating'
    error={progress.error}
    migration={progress}
    onRetry={async () => {}}
    onCreateEncryptedExport={async () => {}}
    onConfirmEncryptedExport={async () => {}}
    onLogout={async () => {}}
  />);
}
