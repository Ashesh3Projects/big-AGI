import * as React from 'react';
import { Button, Chip, Stack, Typography } from '@mui/joy';

import type { PrivateProSyncPhase } from '../sync/store-private-pro-sync';


const labels: Record<PrivateProSyncPhase, string> = {
  local: 'Local',
  syncing: 'Syncing',
  synced: 'Synced',
  offline: 'Offline',
  error: 'Sync error',
};

export function PrivateProSyncStatus(props: {
  phase: PrivateProSyncPhase;
  pending: number;
  busy?: boolean;
  onRetry: () => void;
}) {
  const retryable = props.phase === 'offline' || props.phase === 'error';
  return (
    <Stack direction='row' spacing={1} alignItems='center' justifyContent='space-between'>
      <Stack direction='row' spacing={1} alignItems='center'>
        <Chip size='sm' color={props.phase === 'synced' ? 'success' : props.phase === 'error' ? 'danger' : 'neutral'}>{labels[props.phase]}</Chip>
        {props.pending > 0 && <Typography level='body-xs' textColor='text.secondary'>{props.pending} pending</Typography>}
      </Stack>
      {retryable && <Button size='sm' variant='plain' color='neutral' loading={props.busy} onClick={props.onRetry}>Retry</Button>}
    </Stack>
  );
}
